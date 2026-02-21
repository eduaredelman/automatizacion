const { query } = require('../config/database');
const { success, error, paginated } = require('../utils/response');
const logger = require('../utils/logger');

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

    const countResult = await query(`SELECT COUNT(*) FROM payments p ${where}`, params);
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
    const [total, byStatus, byMethod, today] = await Promise.all([
      query('SELECT COUNT(*) as total, SUM(amount) as total_amount FROM payments WHERE status = $1', ['validated']),
      query(`SELECT status, COUNT(*) as count FROM payments GROUP BY status`),
      query(`SELECT payment_method, COUNT(*) as count, SUM(amount) as total FROM payments WHERE status = 'validated' GROUP BY payment_method ORDER BY count DESC`),
      query(`SELECT COUNT(*) as count FROM payments WHERE DATE(created_at) = CURRENT_DATE`),
    ]);

    const activeChats = await query(
      `SELECT status, COUNT(*) as count FROM conversations WHERE is_archived = false GROUP BY status`
    );

    return success(res, {
      payments: {
        total_validated: parseInt(total.rows[0]?.total || 0),
        total_amount: parseFloat(total.rows[0]?.total_amount || 0),
        today: parseInt(today.rows[0]?.count || 0),
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

// PATCH /api/payments/:id/validate - Manual validation by agent
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

    await query(
      `INSERT INTO events (conversation_id, payment_id, agent_id, event_type, description)
       VALUES ($1, $2, $3, 'payment_validated_manual', 'Pago validado manualmente por agente')`,
      [result.rows[0].conversation_id, id, req.agent.id]
    );

    return success(res, result.rows[0], 'Pago validado');
  } catch (err) {
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

module.exports = { listPayments, getStats, getPayment, validatePayment, rejectPayment };
