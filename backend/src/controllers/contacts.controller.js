const { query } = require('../config/database');
const { success, error, paginated } = require('../utils/response');
const wisphub = require('../services/wisphub.service');
const whatsapp = require('../services/whatsapp.service');
const logger = require('../utils/logger');

// GET /api/contacts?search=&status=&page=&limit=
const getContacts = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(100, parseInt(req.query.limit || '50'));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim();

    const conditions = [];
    const params     = [];
    let   pi         = 1;

    if (search) {
      conditions.push(`(LOWER(name) LIKE $${pi} OR phone LIKE $${pi + 1})`);
      params.push(`%${search.toLowerCase()}%`, `%${search}%`);
      pi += 2;
    }

    if (status) {
      conditions.push(`service_status = $${pi}`);
      params.push(status);
      pi++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countResult, rowsResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM clients ${where}`, params),
      query(
        `SELECT id, wisphub_id, phone, name, email, service_id, plan, plan_price,
                address, service_status, tags, last_synced_at, created_at
         FROM clients ${where}
         ORDER BY name ASC
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    return paginated(res, rowsResult.rows, total, page, limit);

  } catch (err) {
    logger.error('getContacts error', { error: err.message });
    return error(res, 'Error al obtener contactos');
  }
};

// POST /api/contacts/sync
const syncContacts = async (req, res) => {
  try {
    logger.info('[CONTACTS] Sincronización manual solicitada', { agent: req.agent?.email });
    const result = await wisphub.sincronizarContactos({ query });
    return success(res, result, 'Sincronización completada');
  } catch (err) {
    logger.error('syncContacts error', { error: err.message });
    return error(res, 'Error al sincronizar contactos');
  }
};

// GET /api/contacts/sync/status
const getSyncStatus = async (req, res) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE service_status = 'activo')  AS activos,
         COUNT(*) FILTER (WHERE service_status = 'cortado') AS cortados,
         MAX(last_synced_at) AS last_sync
       FROM clients`
    );
    return success(res, result.rows[0]);
  } catch (err) {
    logger.error('getSyncStatus error', { error: err.message });
    return error(res, 'Error al obtener estado de sincronización');
  }
};

// POST /api/contacts/:wisphub_id/message
const sendMessage = async (req, res) => {
  try {
    const { wisphub_id } = req.params;
    const { message } = req.body;

    if (!message?.trim()) {
      return error(res, 'El mensaje es requerido', 400);
    }

    const result = await query(
      'SELECT phone, name FROM clients WHERE wisphub_id = $1',
      [wisphub_id]
    );

    if (!result.rows.length) {
      return error(res, 'Contacto no encontrado', 404);
    }

    const { phone, name } = result.rows[0];
    if (!phone) {
      return error(res, 'El contacto no tiene teléfono registrado', 400);
    }

    const text = message.replace(/\{nombre\}/gi, name || '');
    await whatsapp.sendTextMessage(phone, text);

    logger.info('[CONTACTS] Mensaje enviado', { wisphub_id, phone, agent: req.agent?.email });
    return success(res, { phone, name }, 'Mensaje enviado correctamente');

  } catch (err) {
    logger.error('sendMessage error', { error: err.message });
    return error(res, 'Error al enviar mensaje');
  }
};

// GET /api/contacts/debug/wisphub — Ver muestra de datos crudos de WispHub (diagnóstico)
const debugWisphub = async (req, res) => {
  try {
    // Solo traer 3 clientes para no saturar
    const axios = require('axios');
    const { data } = await axios.get(`${process.env.WISPHUB_API_URL}/clientes/`, {
      headers: { Authorization: `Api-Key ${process.env.WISPHUB_API_TOKEN}` },
      params: { limit: 3 },
      timeout: 15000,
    });
    const samples = (data.results || data || []).slice(0, 3);
    return success(res, {
      total_en_respuesta: data.count || samples.length,
      muestra: samples.map(c => ({
        id_servicio: c.id_servicio,
        id:          c.id,
        nombre:      c.nombre,
        activo:      c.activo,
        estado:      c.estado,
        status:      c.status,
        celular:     c.celular,
        plan:        c.plan,
        precio_plan: c.precio_plan,
        keys:        Object.keys(c),
      })),
    }, 'Muestra WispHub');
  } catch (err) {
    logger.error('debugWisphub error', { error: err.message });
    return error(res, `Error al consultar WispHub: ${err.message}`);
  }
};

// GET /api/contacts/debug/db — Ver distribución de service_status en la DB
const debugDb = async (req, res) => {
  try {
    const [dist, sample] = await Promise.all([
      query(`SELECT service_status, COUNT(*) as total FROM clients GROUP BY service_status ORDER BY total DESC`),
      query(`SELECT wisphub_id, name, service_status, wisphub_raw->'activo' as raw_activo,
                    wisphub_raw->'estado' as raw_estado, last_synced_at
             FROM clients ORDER BY last_synced_at DESC NULLS LAST LIMIT 5`),
    ]);
    return success(res, {
      distribucion: dist.rows,
      ultimos_sincronizados: sample.rows,
    });
  } catch (err) {
    logger.error('debugDb error', { error: err.message });
    return error(res, 'Error al consultar DB');
  }
};

module.exports = { getContacts, syncContacts, getSyncStatus, sendMessage, debugWisphub, debugDb };
