const { query } = require('../config/database');
const whatsapp = require('../services/whatsapp.service');
const { success, error, paginated } = require('../utils/response');
const logger = require('../utils/logger');
const { emitToConversation, emitToAgents } = require('../config/socket');

// GET /api/chats - List conversations
const listChats = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const offset = (page - 1) * limit;
    const status = req.query.status || null;
    const search = req.query.search || null;

    let where = 'WHERE c.is_archived = false';
    const params = [];

    if (status) { params.push(status); where += ` AND c.status = $${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND (c.phone ILIKE $${params.length} OR c.display_name ILIKE $${params.length})`; }

    const countResult = await query(`SELECT COUNT(*) FROM conversations c ${where}`, params);
    const total = parseInt(countResult.rows[0].count);

    params.push(limit, offset);
    const result = await query(
      `SELECT c.*,
        a.name AS agent_name,
        (SELECT COUNT(*) FROM payments p WHERE p.conversation_id = c.id) AS payment_count
       FROM conversations c
       LEFT JOIN agents a ON a.id = c.assigned_to
       ${where}
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return paginated(res, result.rows, total, page, limit);
  } catch (err) {
    logger.error('listChats error', { error: err.message });
    return error(res, 'Error al obtener conversaciones');
  }
};

// GET /api/chats/:id - Get conversation with messages
const getChat = async (req, res) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const convResult = await query(
      `SELECT c.*, a.name AS agent_name, cl.wisphub_id, cl.plan, cl.debt_amount
       FROM conversations c
       LEFT JOIN agents a ON a.id = c.assigned_to
       LEFT JOIN clients cl ON cl.id = c.client_id
       WHERE c.id = $1`,
      [id]
    );

    if (!convResult.rows.length) return error(res, 'Conversación no encontrada', 404);

    const countResult = await query(
      'SELECT COUNT(*) FROM messages WHERE conversation_id = $1',
      [id]
    );

    // Carga los mensajes más recientes (DESC) y luego los re-ordena ASC para mostrar
    // Esto evita que conversaciones largas solo muestren los primeros 50 mensajes (los más viejos)
    const messagesResult = await query(
      `SELECT * FROM (
         SELECT m.*, a.name AS agent_name
         FROM messages m
         LEFT JOIN agents a ON a.id = m.agent_id
         WHERE m.conversation_id = $1
         ORDER BY m.created_at DESC
         LIMIT $2 OFFSET $3
       ) sub ORDER BY created_at ASC`,
      [id, limit, offset]
    );

    const paymentsResult = await query(
      `SELECT * FROM payments WHERE conversation_id = $1 ORDER BY created_at DESC`,
      [id]
    );

    // Reset unread count
    await query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [id]);

    return success(res, {
      conversation: convResult.rows[0],
      messages: messagesResult.rows,
      payments: paymentsResult.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page,
        limit,
        pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      },
    });
  } catch (err) {
    logger.error('getChat error', { error: err.message });
    return error(res, 'Error al obtener conversación');
  }
};

// POST /api/chats/:id/send - Agent sends message
const sendMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text?.trim()) return error(res, 'Mensaje requerido', 400);

    const convResult = await query('SELECT * FROM conversations WHERE id = $1', [id]);
    if (!convResult.rows.length) return error(res, 'Conversación no encontrada', 404);

    const conv = convResult.rows[0];

    // Send via WhatsApp
    const waResult = await whatsapp.sendTextMessage(conv.phone, text.trim());

    // Save message
    const msgResult = await query(
      `INSERT INTO messages (conversation_id, whatsapp_id, direction, sender_type, agent_id, message_type, body, whatsapp_status)
       VALUES ($1, $2, 'outbound', 'agent', $3, 'text', $4, 'sent') RETURNING *`,
      [id, waResult.messages?.[0]?.id || null, req.agent.id, text.trim()]
    );

    // Update conversation
    await query(
      `UPDATE conversations SET last_message = $1, last_message_at = NOW() WHERE id = $2`,
      [text.substring(0, 100), id]
    );

    // Incluir agent_name en el mensaje para que el panel lo muestre correctamente
    const savedMsg = { ...msgResult.rows[0], agent_name: req.agent?.name };

    // Emitir vía socket para que otros agentes vean el mensaje en tiempo real
    emitToConversation(id, 'message', savedMsg);
    emitToAgents('new_message', {
      conversation: { ...conv, last_message: text.substring(0, 100), last_message_at: new Date().toISOString() },
      message: savedMsg,
    });

    return success(res, savedMsg, 'Mensaje enviado');
  } catch (err) {
    logger.error('sendMessage error', { error: err.message });
    return error(res, 'Error al enviar mensaje');
  }
};

// POST /api/chats/:id/takeover - Human agent takes control
const takeover = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const convResult = await query('SELECT * FROM conversations WHERE id = $1', [id]);
    if (!convResult.rows.length) return error(res, 'Conversación no encontrada', 404);

    // Close existing active sessions
    await query(
      `UPDATE takeover_sessions SET is_active = false, ended_at = NOW() WHERE conversation_id = $1 AND is_active = true`,
      [id]
    );

    // Create new session
    await query(
      `INSERT INTO takeover_sessions (conversation_id, agent_id, reason) VALUES ($1, $2, $3)`,
      [id, req.agent.id, reason || 'Intervención manual']
    );

    // Update conversation
    await query(
      `UPDATE conversations SET status = 'human', assigned_to = $1 WHERE id = $2`,
      [req.agent.id, id]
    );

    // Log event
    await query(
      `INSERT INTO events (conversation_id, agent_id, event_type, description)
       VALUES ($1, $2, 'agent_takeover', $3)`,
      [id, req.agent.id, reason || 'Agente tomó control del chat']
    );

    logger.info('Agent took over conversation', { conversationId: id, agentId: req.agent.id });
    return success(res, {}, 'Control tomado. El bot está desactivado para este chat.');
  } catch (err) {
    logger.error('takeover error', { error: err.message });
    return error(res, 'Error al tomar control');
  }
};

// POST /api/chats/:id/release - Release back to bot
const release = async (req, res) => {
  try {
    const { id } = req.params;

    await query(
      `UPDATE takeover_sessions SET is_active = false, ended_at = NOW()
       WHERE conversation_id = $1 AND is_active = true`,
      [id]
    );

    await query(
      `UPDATE conversations SET status = 'bot', assigned_to = NULL WHERE id = $1`,
      [id]
    );

    await query(
      `INSERT INTO events (conversation_id, agent_id, event_type, description)
       VALUES ($1, $2, 'bot_resumed', 'Bot reactivado')`,
      [id, req.agent.id]
    );

    return success(res, {}, 'Bot reactivado para este chat');
  } catch (err) {
    logger.error('release error', { error: err.message });
    return error(res, 'Error al liberar chat');
  }
};

// GET /api/chats/:id/payments - Payments for a conversation
const getPayments = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT p.*, a.name AS validated_by_name
       FROM payments p
       LEFT JOIN agents a ON a.id = p.validated_by
       WHERE p.conversation_id = $1
       ORDER BY p.created_at DESC`,
      [id]
    );
    return success(res, result.rows);
  } catch (err) {
    return error(res, 'Error al obtener pagos');
  }
};

// PATCH /api/chats/:id/resolve - Resolve conversation
const resolve = async (req, res) => {
  try {
    const { id } = req.params;
    await query(`UPDATE conversations SET status = 'resolved' WHERE id = $1`, [id]);
    return success(res, {}, 'Conversación resuelta');
  } catch (err) {
    return error(res, 'Error al resolver conversación');
  }
};

module.exports = { listChats, getChat, sendMessage, takeover, release, getPayments, resolve };
