const { query } = require('../config/database');
const wisphub = require('../services/wisphub.service');

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

// ─────────────────────────────────────────────────────────────
// RECONCILIAR: buscar en WispHub pagos que el sistema marcó como
// "no registrado" pero que realmente sí están registrados allá.
// ─────────────────────────────────────────────────────────────
const reconcilePayments = async (req, res) => {
  try {
    // 1. Obtener todos los pagos validados sin registrar, con datos del cliente
    const { rows: payments } = await query(`
      SELECT
        p.id,
        p.amount,
        p.payment_date,
        p.validated_at,
        p.created_at,
        p.operation_code,
        cl.wisphub_id,
        cl.wisphub_raw->>'usuario' AS wisphub_usuario
      FROM payments p
      JOIN conversations conv ON conv.id = p.conversation_id
      LEFT JOIN clients cl ON cl.id = conv.client_id
      WHERE p.status = 'validated'
        AND p.registered_wisphub = false
        AND cl.wisphub_id IS NOT NULL
      ORDER BY p.created_at DESC
      LIMIT 200
    `);

    if (payments.length === 0) {
      return res.json({ success: true, updated: 0, checked: 0, message: 'Todos los pagos ya están sincronizados.' });
    }

    // 2. Agrupar por cliente para hacer una sola llamada a WispHub por cliente
    const byClient = new Map();
    for (const p of payments) {
      const key = p.wisphub_id;
      if (!byClient.has(key)) {
        byClient.set(key, { wisphubId: p.wisphub_id, wisphubUsuario: p.wisphub_usuario, payments: [] });
      }
      byClient.get(key).payments.push(p);
    }

    let updated = 0;
    const AMOUNT_TOL = 1.0; // tolerancia S/1 para coincidir monto
    const DATE_TOL_MS = 10 * 24 * 60 * 60 * 1000; // ±10 días

    // 3. Para cada cliente, buscar sus facturas pagadas en WispHub
    for (const { wisphubId, wisphubUsuario, payments: clientPayments } of byClient.values()) {
      let facturasPagadas = [];
      try {
        facturasPagadas = await wisphub.buscarFacturasPagadas(wisphubId, wisphubUsuario);
      } catch {
        continue;
      }

      if (facturasPagadas.length === 0) continue;

      // 4. Intentar hacer coincidir cada pago con una factura pagada
      for (const pmt of clientPayments) {
        const pmtAmount = parseFloat(pmt.amount || 0);
        const pmtDate = new Date(pmt.payment_date || pmt.validated_at || pmt.created_at).getTime();

        const match = facturasPagadas.find(f => {
          const fMonto = parseFloat(f.total || f.sub_total || f.monto || 0);
          if (Math.abs(fMonto - pmtAmount) > AMOUNT_TOL) return false;

          // Si tenemos fecha de pago en la factura, verificar proximidad
          const fFecha = f.fecha_pago || f.fecha_cobro || f.fecha_vencimiento || null;
          if (fFecha) {
            const fDate = new Date(fFecha).getTime();
            if (!isNaN(fDate) && Math.abs(fDate - pmtDate) > DATE_TOL_MS) return false;
          }

          return true;
        });

        if (match) {
          const facturaId = match.id_factura || match.id || null;
          await query(
            `UPDATE payments SET registered_wisphub = true, factura_id = $2, updated_at = NOW() WHERE id = $1`,
            [pmt.id, facturaId ? String(facturaId) : null]
          );
          updated++;
        }
      }

      // Pequeña pausa para no sobrecargar WispHub
      await new Promise(r => setTimeout(r, 300));
    }

    return res.json({
      success: true,
      checked: payments.length,
      updated,
      message: updated > 0
        ? `${updated} pago(s) actualizados como registrados en WispHub.`
        : 'No se encontraron coincidencias adicionales en WispHub.',
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { listBotPayments, reconcilePayments };
