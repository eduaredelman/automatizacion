const { query } = require('../config/database');
const { success, error, paginated } = require('../utils/response');
const logger = require('../utils/logger');
const wisphub = require('../services/wisphub.service');

// GET /api/payments - List all payments
const listPayments = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status || null;
    const method = req.query.method || null;

    let where = 'WHERE 1=1';
    const params = [];

    if (status) { params.push(status); where += ` AND p.status = $${params.length}`; }
    if (method) { params.push(method); where += ` AND p.payment_method = $${params.length}`; }

    const search = req.query.search || null;
    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      where += ` AND (c.display_name ILIKE $${idx} OR c.phone ILIKE $${idx} OR p.operation_code ILIKE $${idx} OR p.payer_name ILIKE $${idx})`;
    }

    const wisphubFilter = req.query.wisphub_filter || null;
    if (wisphubFilter === 'unregistered') {
      where += ` AND p.status = 'validated' AND (p.registered_wisphub = false OR p.registered_wisphub IS NULL)`;
    }

    // Filtro por mes/año opcional (usa payment_date o validated_at o created_at)
    const mesFilter = parseInt(req.query.mes) || null;
    const anoFilter = parseInt(req.query.ano) || null;
    if (mesFilter && anoFilter) {
      const de = `COALESCE(p.payment_date::timestamptz, p.validated_at, p.created_at)`;
      params.push(anoFilter); where += ` AND EXTRACT(YEAR  FROM ${de}) = $${params.length}`;
      params.push(mesFilter); where += ` AND EXTRACT(MONTH FROM ${de}) = $${params.length}`;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM payments p LEFT JOIN conversations c ON c.id = p.conversation_id ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    params.push(limit, offset);
    const result = await query(
      `SELECT p.*,
         c.phone, c.display_name,
         a.name AS validated_by_name
       FROM payments p
       LEFT JOIN conversations c ON c.id = p.conversation_id
       LEFT JOIN agents a ON a.id = p.validated_by
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return paginated(res, result.rows, total, page, limit);
  } catch (err) {
    logger.error('listPayments error', { error: err.message });
    return error(res, 'Error al obtener pagos');
  }
};

// GET /api/payments/stats - Dashboard stats
const getStats = async (req, res) => {
  try {
    const [total, byStatus, byMethod, today, unregistered] = await Promise.all([
      query('SELECT COUNT(*) as total, SUM(amount) as total_amount FROM payments WHERE status = $1', ['validated']),
      query(`SELECT status, COUNT(*) as count FROM payments GROUP BY status`),
      query(`SELECT payment_method, COUNT(*) as count, SUM(amount) as total FROM payments WHERE status = 'validated' GROUP BY payment_method ORDER BY count DESC`),
      query(`SELECT COUNT(*) as count FROM payments WHERE DATE(created_at) = CURRENT_DATE`),
      query(`SELECT COUNT(*) as count FROM payments WHERE status = 'validated' AND (registered_wisphub = false OR registered_wisphub IS NULL)`),
    ]);

    const activeChats = await query(
      `SELECT status, COUNT(*) as count FROM conversations WHERE is_archived = false GROUP BY status`
    );

    return success(res, {
      payments: {
        total_validated: parseInt(total.rows[0]?.total || 0),
        total_amount: parseFloat(total.rows[0]?.total_amount || 0),
        today: parseInt(today.rows[0]?.count || 0),
        unregistered_wisphub: parseInt(unregistered.rows[0]?.count || 0),
        by_status: byStatus.rows,
        by_method: byMethod.rows,
      },
      conversations: {
        by_status: activeChats.rows,
      },
    });
  } catch (err) {
    logger.error('getStats error', { error: err.message });
    return error(res, 'Error al obtener estadísticas');
  }
};

// GET /api/payments/:id - Payment detail
const getPayment = async (req, res) => {
  try {
    const result = await query(
      `SELECT p.*, c.phone, c.display_name, a.name AS validated_by_name
       FROM payments p
       LEFT JOIN conversations c ON c.id = p.conversation_id
       LEFT JOIN agents a ON a.id = p.validated_by
       WHERE p.id = $1`,
      [req.params.id]
    );

    if (!result.rows.length) return error(res, 'Pago no encontrado', 404);
    return success(res, result.rows[0]);
  } catch (err) {
    return error(res, 'Error al obtener pago');
  }
};

// PATCH /api/payments/:id/validate - Manual validation by agent + auto-register in WispHub
const validatePayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const result = await query(
      `UPDATE payments SET
         status = 'validated',
         validated_by = $1,
         validated_at = NOW(),
         notes = $2
       WHERE id = $3 RETURNING *`,
      [req.agent.id, notes || null, id]
    );

    if (!result.rows.length) return error(res, 'Pago no encontrado', 404);
    const payment = result.rows[0];

    await query(
      `INSERT INTO events (conversation_id, payment_id, agent_id, event_type, description)
       VALUES ($1, $2, $3, 'payment_validated_manual', 'Pago validado manualmente por agente')`,
      [payment.conversation_id, id, req.agent.id]
    );

    // ── Registrar automáticamente en WispHub ─────────────────────────────
    let wisphubRegistered = false;
    let wisphubError = null;

    if (payment.client_id) {
      try {
        const clientResult = await query(
          'SELECT wisphub_id FROM clients WHERE id = $1',
          [payment.client_id]
        );
        const wisphubId = clientResult.rows[0]?.wisphub_id;

        if (wisphubId) {
          await wisphub.registrarPago(wisphubId, {
            amount:        payment.amount,
            method:        payment.payment_method,
            operationCode: payment.operation_code,
            paymentDate:   payment.payment_date,
            facturaId:     payment.factura_id || null,
          });
          await query('UPDATE payments SET registered_wisphub = true WHERE id = $1', [id]);
          wisphubRegistered = true;
        } else {
          wisphubError = 'Cliente sin ID WispHub vinculado';
          logger.warn('WispHub: no wisphub_id para client_id', { clientId: payment.client_id, paymentId: id });
        }
      } catch (err) {
        wisphubError = err.response?.data?.detail || err.response?.data?.message || err.message;
        logger.warn('WispHub: registro automático fallido', { paymentId: id, error: wisphubError });
      }
    } else {
      wisphubError = 'Pago sin cliente vinculado en el CRM';
      logger.warn('WispHub: pago sin client_id', { paymentId: id });
    }
    // ─────────────────────────────────────────────────────────────────────

    const msg = wisphubRegistered
      ? 'Pago validado y registrado en WispHub ✅'
      : `Pago validado (WispHub: ${wisphubError || 'no registrado'})`;

    return success(res, { ...payment, wisphub_registered: wisphubRegistered, wisphub_error: wisphubError }, msg);
  } catch (err) {
    logger.error('validatePayment error', { error: err.message });
    return error(res, 'Error al validar pago');
  }
};

// PATCH /api/payments/:id/reject - Reject payment
const rejectPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await query(
      `UPDATE payments SET status = 'rejected', rejection_reason = $1, validated_by = $2, validated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [reason || 'Rechazado por agente', req.agent.id, id]
    );

    if (!result.rows.length) return error(res, 'Pago no encontrado', 404);
    return success(res, result.rows[0], 'Pago rechazado');
  } catch (err) {
    return error(res, 'Error al rechazar pago');
  }
};

// DELETE /api/payments/:id - Permanently delete a payment record
const deletePayment = async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que el pago existe antes de eliminar
    const check = await query('SELECT id, status FROM payments WHERE id = $1', [id]);
    if (!check.rows.length) return error(res, 'Pago no encontrado', 404);

    // Registrar en eventos antes de eliminar (auditoría)
    await query(
      `INSERT INTO events (conversation_id, payment_id, agent_id, event_type, description)
       SELECT conversation_id, $1, $2, 'payment_deleted', 'Pago eliminado permanentemente por agente'
       FROM payments WHERE id = $1`,
      [id, req.agent.id]
    ).catch(() => {}); // No bloquear si el evento falla

    await query('DELETE FROM payments WHERE id = $1', [id]);

    logger.info('Payment permanently deleted', { paymentId: id, agentId: req.agent.id });
    return success(res, { id }, 'Pago eliminado permanentemente');
  } catch (err) {
    logger.error('deletePayment error', { error: err.message });
    return error(res, 'Error al eliminar pago');
  }
};

// POST /api/payments/:id/register-wisphub - Registrar pago validado en WispHub (retry)
const registerWisphub = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT p.*, c.phone AS conv_phone, c.display_name FROM payments p
       LEFT JOIN conversations c ON c.id = p.conversation_id
       WHERE p.id = $1`,
      [id]
    );
    if (!result.rows.length) return error(res, 'Pago no encontrado', 404);
    const payment = result.rows[0];
    if (payment.status !== 'validated') return error(res, 'Solo se pueden registrar pagos validados', 400);

    const phone = payment.conv_phone || null;
    let wisphubId = null;

    // 1. Buscar en clients local por client_id
    if (payment.client_id) {
      const r = await query('SELECT wisphub_id FROM clients WHERE id = $1', [payment.client_id]);
      wisphubId = r.rows[0]?.wisphub_id || null;
    }

    // 2. Buscar en clients local por teléfono
    if (!wisphubId && phone) {
      const r = await query(
        `SELECT wisphub_id FROM clients WHERE phone = $1 OR phone = $2 LIMIT 1`,
        [phone, phone.replace(/^51/, '')]
      );
      wisphubId = r.rows[0]?.wisphub_id || null;
    }

    // 3. Buscar directamente en WispHub API por teléfono/nombre del pagador
    if (!wisphubId && phone) {
      const client = await wisphub.buscarCliente(phone, payment.payer_name || payment.display_name || null);
      if (client) {
        wisphubId = client.id_servicio || client.id;
        // Guardar en local para futuros lookups
        if (wisphubId) {
          await query(
            `INSERT INTO clients (wisphub_id, phone, name, service_id, last_synced_at)
             VALUES ($1,$2,$3,$4,NOW())
             ON CONFLICT (wisphub_id) DO UPDATE SET phone=$2, last_synced_at=NOW()`,
            [String(wisphubId), phone, client.nombre || client.name || null, String(wisphubId)]
          );
        }
      }
    }

    if (!wisphubId) {
      return error(res, 'No se encontró cliente en WispHub. Verifica que el teléfono esté registrado.', 422);
    }

    await wisphub.registrarPago(String(wisphubId), {
      amount:        payment.amount,
      method:        payment.payment_method,
      operationCode: payment.operation_code,
      paymentDate:   payment.payment_date,
      facturaId:     payment.factura_id || null,
    });

    await query('UPDATE payments SET registered_wisphub = true WHERE id = $1', [id]);
    logger.info('Pago registrado en WispHub (retry)', { paymentId: id, wisphubId });

    return success(res, { id, registered_wisphub: true }, 'Pago registrado en WispHub ✅');
  } catch (err) {
    const msg = err.response?.data?.detail || err.response?.data?.message || err.message;
    logger.error('registerWisphub error', { paymentId: req.params.id, error: msg });
    return error(res, `Error al registrar en WispHub: ${msg}`);
  }
};

module.exports = { listPayments, getStats, getPayment, validatePayment, rejectPayment, deletePayment, registerWisphub };
