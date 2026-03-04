const { query } = require('../config/database');
const { success, error, paginated } = require('../utils/response');
const whatsapp = require('../services/whatsapp.service');
const { emitToAgents } = require('../config/socket');
const logger = require('../utils/logger');

// GET /api/campaigns
const getCampaigns = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(50,  parseInt(req.query.limit || '20'));
    const offset = (page - 1) * limit;

    const [countRes, rowsRes] = await Promise.all([
      query('SELECT COUNT(*) FROM mass_campaigns'),
      query(
        `SELECT mc.*, a.name AS created_by_name
         FROM mass_campaigns mc
         LEFT JOIN agents a ON a.id = mc.created_by
         ORDER BY mc.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
    ]);

    return paginated(res, rowsRes.rows, parseInt(countRes.rows[0].count), page, limit);
  } catch (err) {
    logger.error('getCampaigns error', { error: err.message });
    return error(res, 'Error al obtener campañas');
  }
};

// POST /api/campaigns
const createCampaign = async (req, res) => {
  try {
    const { name, message, filter_status } = req.body;
    if (!name?.trim() || !message?.trim()) {
      return error(res, 'Nombre y mensaje son requeridos', 400);
    }

    // Obtener destinatarios según filtro
    let whereClause = "phone != ''";
    const params = [];
    if (filter_status && filter_status !== 'all') {
      whereClause += ' AND service_status = $1';
      params.push(filter_status);
    }

    const clientsRes = await query(
      `SELECT id, wisphub_id, phone, name FROM clients WHERE ${whereClause} ORDER BY name`,
      params
    );

    const recipients = clientsRes.rows.filter(c => c.phone);
    if (!recipients.length) {
      return error(res, 'No hay destinatarios con teléfono registrado', 400);
    }

    // Crear campaña
    const campRes = await query(
      `INSERT INTO mass_campaigns (name, message, status, total_recipients, created_by)
       VALUES ($1, $2, 'running', $3, $4)
       RETURNING *`,
      [name.trim(), message.trim(), recipients.length, req.agent.id]
    );
    const campaign = campRes.rows[0];

    // Insertar destinatarios
    for (const c of recipients) {
      await query(
        `INSERT INTO campaign_recipients (campaign_id, client_id, phone, name)
         VALUES ($1, $2, $3, $4)`,
        [campaign.id, c.id, c.phone, c.name]
      ).catch(() => {});
    }

    // Responder inmediatamente, enviar en background
    res.status(201).json({ success: true, data: campaign, message: 'Campaña iniciada' });

    // Background: enviar mensajes
    setImmediate(() => _runCampaign(campaign.id, message.trim()));

  } catch (err) {
    logger.error('createCampaign error', { error: err.message });
    if (!res.headersSent) return error(res, 'Error al crear campaña');
  }
};

// GET /api/campaigns/:id
const getCampaignDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const [campRes, recipRes] = await Promise.all([
      query(
        `SELECT mc.*, a.name AS created_by_name
         FROM mass_campaigns mc
         LEFT JOIN agents a ON a.id = mc.created_by
         WHERE mc.id = $1`,
        [id]
      ),
      query(
        `SELECT id, phone, name, status, sent_at, error_message, whatsapp_message_id
         FROM campaign_recipients
         WHERE campaign_id = $1
         ORDER BY name`,
        [id]
      ),
    ]);

    if (!campRes.rows.length) return error(res, 'Campaña no encontrada', 404);

    return success(res, {
      campaign: campRes.rows[0],
      recipients: recipRes.rows,
    });
  } catch (err) {
    logger.error('getCampaignDetail error', { error: err.message });
    return error(res, 'Error al obtener detalle de campaña');
  }
};

// POST /api/campaigns/:id/cancel
const cancelCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE mass_campaigns
       SET status = 'cancelled', completed_at = NOW()
       WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [id]
    );
    if (!result.rows.length) {
      return error(res, 'Campaña no encontrada o ya finalizada', 404);
    }
    emitToAgents('campaign_update', result.rows[0]);
    return success(res, result.rows[0], 'Campaña cancelada');
  } catch (err) {
    logger.error('cancelCampaign error', { error: err.message });
    return error(res, 'Error al cancelar campaña');
  }
};

// ─── Background: envío real de mensajes ──────────────────────────────────────

const _runCampaign = async (campaignId, messageTemplate) => {
  logger.info(`[CAMPAIGN] Iniciando envío campaña ${campaignId}`);

  try {
    // Verificar que no fue cancelada antes de empezar
    const checkRes = await query(
      'SELECT status FROM mass_campaigns WHERE id = $1',
      [campaignId]
    );
    if (!checkRes.rows.length || checkRes.rows[0].status !== 'running') {
      logger.info(`[CAMPAIGN] Campaña ${campaignId} cancelada antes de iniciar`);
      return;
    }

    // Marcar como iniciada
    await query(
      'UPDATE mass_campaigns SET started_at = NOW() WHERE id = $1',
      [campaignId]
    );

    const recipientsRes = await query(
      `SELECT id, phone, name FROM campaign_recipients
       WHERE campaign_id = $1 AND status = 'pending'
       ORDER BY id`,
      [campaignId]
    );

    let sentCount = 0;
    let failedCount = 0;

    for (const r of recipientsRes.rows) {
      // Verificar cancelación entre mensajes
      const statusCheck = await query(
        'SELECT status FROM mass_campaigns WHERE id = $1',
        [campaignId]
      );
      if (statusCheck.rows[0]?.status === 'cancelled') {
        logger.info(`[CAMPAIGN] ${campaignId} cancelada durante envío`);
        break;
      }

      try {
        const text = messageTemplate.replace(/\{nombre\}/gi, r.name || '');
        const waRes = await whatsapp.sendTextMessage(r.phone, text);
        const waId  = waRes?.messages?.[0]?.id || null;

        await query(
          `UPDATE campaign_recipients
           SET status = 'sent', sent_at = NOW(), whatsapp_message_id = $2
           WHERE id = $1`,
          [r.id, waId]
        );
        sentCount++;

      } catch (err) {
        await query(
          `UPDATE campaign_recipients
           SET status = 'failed', error_message = $2
           WHERE id = $1`,
          [r.id, err.message?.substring(0, 200)]
        );
        failedCount++;
        logger.warn(`[CAMPAIGN] Fallo enviando a ${r.phone}`, { error: err.message });
        // Espera extra si hay error (throttling)
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Rate limiting: ~80 msgs/s en Cloud API, usamos 200ms de pausa
      await new Promise(r => setTimeout(r, 200));

      // Emitir progreso cada 10 mensajes
      if ((sentCount + failedCount) % 10 === 0) {
        const updRes = await query(
          `UPDATE mass_campaigns
           SET sent_count = $2, failed_count = $3
           WHERE id = $1
           RETURNING *`,
          [campaignId, sentCount, failedCount]
        );
        emitToAgents('campaign_update', updRes.rows[0]);
      }
    }

    // Finalizar campaña
    const finalRes = await query(
      `UPDATE mass_campaigns
       SET status = 'completed', completed_at = NOW(),
           sent_count = $2, failed_count = $3
       WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [campaignId, sentCount, failedCount]
    );

    if (finalRes.rows.length) {
      emitToAgents('campaign_update', finalRes.rows[0]);
    }

    logger.info(`[CAMPAIGN] Completada ${campaignId}: ${sentCount} enviados, ${failedCount} fallidos`);

  } catch (err) {
    logger.error(`[CAMPAIGN] Error crítico campaña ${campaignId}`, { error: err.message });
    await query(
      `UPDATE mass_campaigns SET status = 'failed', completed_at = NOW() WHERE id = $1`,
      [campaignId]
    ).catch(() => {});
  }
};

module.exports = { getCampaigns, createCampaign, getCampaignDetail, cancelCampaign };
