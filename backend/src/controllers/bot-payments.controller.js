const { query } = require('../config/database');

const MESES_ES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const listBotPayments = async (req, res) => {
  try {
    const now = new Date();
    const targetYear  = parseInt(req.query.ano)  || now.getFullYear();
    const targetMonth = parseInt(req.query.mes)  || (now.getMonth() + 1);
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    // Usar payment_date si existe, sino validated_at, sino created_at
    const dateExpr = `COALESCE(p.payment_date::timestamptz, p.validated_at, p.created_at)`;

    const rows = await query(`
      SELECT
        p.id,
        p.amount,
        p.payment_method,
        p.payment_date,
        p.operation_code,
        p.voucher_url,
        p.factura_id,
        p.registered_wisphub,
        p.validated_at,
        p.created_at,
        p.payer_name,
        COALESCE(c.display_name, p.payer_name, 'N/A') AS nombre_cliente,
        c.phone AS telefono_cliente,
        EXTRACT(MONTH FROM ${dateExpr}) AS mes,
        EXTRACT(YEAR  FROM ${dateExpr}) AS ano
      FROM payments p
      LEFT JOIN conversations c ON c.id = p.conversation_id
      WHERE p.status = 'validated'
        AND EXTRACT(YEAR  FROM ${dateExpr}) = $1
        AND EXTRACT(MONTH FROM ${dateExpr}) = $2
      ORDER BY p.created_at DESC
      LIMIT $3 OFFSET $4
    `, [targetYear, targetMonth, limit, offset]);

    const countRow = await query(`
      SELECT COUNT(*) AS total, COALESCE(SUM(p.amount), 0) AS total_amount
      FROM payments p
      WHERE p.status = 'validated'
        AND EXTRACT(YEAR  FROM ${dateExpr}) = $1
        AND EXTRACT(MONTH FROM ${dateExpr}) = $2
    `, [targetYear, targetMonth]);

    return res.json({
      success: true,
      data: {
        payments:     rows.rows,
        total:        parseInt(countRow.rows[0].total),
        total_amount: parseFloat(countRow.rows[0].total_amount),
        mes:          targetMonth,
        ano:          targetYear,
        mes_nombre:   MESES_ES[targetMonth] || '',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { listBotPayments };
