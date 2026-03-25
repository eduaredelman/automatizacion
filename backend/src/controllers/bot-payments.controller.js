const { query } = require('../config/database');
const wisphub = require('../services/wisphub.service');
const whatsapp = require('../services/whatsapp.service');
const { emitToAgents } = require('../config/socket');
const logger = require('../utils/logger');

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
//
// ⚡ IMPORTANTE: Esta operación puede tardar +60s si hay muchos clientes.
// Por eso responde 202 inmediatamente y corre en background.
// El resultado se emite via Socket.IO al terminar → event: 'reconcile_done'
// ─────────────────────────────────────────────────────────────
const reconcilePayments = async (req, res) => {
  // Responder inmediatamente — el proceso pesado corre en background
  res.status(202).json({
    success: true,
    message: 'Reconciliación iniciada. Recibirás el resultado en unos momentos...',
  });

  // Ejecutar en background sin bloquear el event loop
  setImmediate(async () => {
    try {
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
        emitToAgents('reconcile_done', { success: true, updated: 0, checked: 0, message: 'Todos los pagos ya están sincronizados.' });
        return;
      }

      // Agrupar por cliente para hacer una sola llamada a WispHub por cliente
      const byClient = new Map();
      for (const p of payments) {
        const key = p.wisphub_id;
        if (!byClient.has(key)) {
          byClient.set(key, { wisphubId: p.wisphub_id, wisphubUsuario: p.wisphub_usuario, payments: [] });
        }
        byClient.get(key).payments.push(p);
      }

      let updated = 0;
      const AMOUNT_TOL = 1.0;
      const DATE_TOL_MS = 10 * 24 * 60 * 60 * 1000; // ±10 días

      for (const { wisphubId, wisphubUsuario, payments: clientPayments } of byClient.values()) {
        let facturasPagadas = [];
        try {
          facturasPagadas = await wisphub.buscarFacturasPagadas(wisphubId, wisphubUsuario);
        } catch {
          continue;
        }

        if (facturasPagadas.length === 0) continue;

        for (const pmt of clientPayments) {
          const pmtAmount = parseFloat(pmt.amount || 0);
          const pmtDate = new Date(pmt.payment_date || pmt.validated_at || pmt.created_at).getTime();

          const match = facturasPagadas.find(f => {
            const fMonto = parseFloat(f.total || f.sub_total || f.monto || 0);
            if (Math.abs(fMonto - pmtAmount) > AMOUNT_TOL) return false;
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

        // Pausa para no sobrecargar WispHub
        await new Promise(r => setTimeout(r, 300));
      }

      const message = updated > 0
        ? `${updated} pago(s) actualizados como registrados en WispHub.`
        : 'No se encontraron coincidencias adicionales en WispHub.';

      logger.info('Reconciliación completada', { checked: payments.length, updated });
      emitToAgents('reconcile_done', { success: true, checked: payments.length, updated, message });

    } catch (err) {
      logger.error('reconcilePayments background error', { error: err.message });
      emitToAgents('reconcile_done', { success: false, message: `Error en reconciliación: ${err.message}` });
    }
  });
};

// ─────────────────────────────────────────────────────────────
// CONTROL MENSUAL: clientes pagados vs. pendientes del mes
// Fuente de verdad: DB local únicamente
// ─────────────────────────────────────────────────────────────
const listClientesMes = async (req, res) => {
  try {
    const now = new Date();
    const targetYear  = parseInt(req.query.ano)  || now.getFullYear();
    const targetMonth = parseInt(req.query.mes)  || (now.getMonth() + 1);
    const validEstados = ['pagado', 'pendiente', ''];
    const estadoFilter = validEstados.includes(req.query.estado) ? req.query.estado : '';
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(500, parseInt(req.query.limit) || 200);
    const offset = (page - 1) * limit;

    const dateExpr = `COALESCE(p.payment_date::timestamptz, p.validated_at, p.created_at)`;

    const estadoWhere =
      estadoFilter === 'pagado'   ? 'AND pm.client_id IS NOT NULL' :
      estadoFilter === 'pendiente' ? 'AND pm.client_id IS NULL'    : '';

    // CTE: un registro por cliente que pagó este mes (GROUP BY para deduplicar)
    const cteBase = `
      WITH pagos_mes AS (
        SELECT
          COALESCE(p.client_id, conv.client_id) AS client_id,
          MAX(p.amount) AS monto_pagado
        FROM payments p
        LEFT JOIN conversations conv ON conv.id = p.conversation_id
        WHERE p.status = 'validated'
          AND EXTRACT(YEAR  FROM ${dateExpr}) = $1
          AND EXTRACT(MONTH FROM ${dateExpr}) = $2
          AND COALESCE(p.client_id, conv.client_id) IS NOT NULL
        GROUP BY COALESCE(p.client_id, conv.client_id)
      )`;

    const [rowsResult, summaryResult] = await Promise.all([
      query(`
        ${cteBase}
        SELECT
          cl.id, cl.wisphub_id, cl.name, cl.phone,
          cl.plan, cl.plan_price, cl.service_status,
          pm.monto_pagado,
          CASE WHEN pm.client_id IS NOT NULL THEN 'pagado' ELSE 'pendiente' END AS estado_pago
        FROM clients cl
        LEFT JOIN pagos_mes pm ON pm.client_id = cl.id
        WHERE cl.wisphub_id IS NOT NULL
          AND cl.phone IS NOT NULL AND cl.phone != ''
          ${estadoWhere}
        ORDER BY
          CASE WHEN pm.client_id IS NOT NULL THEN 1 ELSE 0 END ASC,
          cl.name ASC
        LIMIT $3 OFFSET $4
      `, [targetYear, targetMonth, limit, offset]),

      query(`
        ${cteBase}
        SELECT
          COUNT(cl.id)::int              AS total_clientes,
          COUNT(pm.client_id)::int       AS pagados,
          (COUNT(cl.id) - COUNT(pm.client_id))::int AS pendientes,
          COALESCE(SUM(pm.monto_pagado), 0)         AS total_recaudado
        FROM clients cl
        LEFT JOIN pagos_mes pm ON pm.client_id = cl.id
        WHERE cl.wisphub_id IS NOT NULL
          AND cl.phone IS NOT NULL AND cl.phone != ''
      `, [targetYear, targetMonth]),
    ]);

    const s = summaryResult.rows[0];
    return res.json({
      success: true,
      data: {
        clientes:   rowsResult.rows,
        summary: {
          total_clientes: s.total_clientes,
          pagados:        s.pagados,
          pendientes:     s.pendientes,
          total_recaudado: parseFloat(s.total_recaudado),
        },
        mes:       targetMonth,
        ano:       targetYear,
        mes_nombre: MESES_ES[targetMonth] || '',
      },
    });
  } catch (err) {
    logger.error('listClientesMes error', { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// ENVIAR MENSAJE MASIVO A DEUDORES DEL MES
// Solo usa DB local — sin consultar WispHub en tiempo real
// ─────────────────────────────────────────────────────────────
const sendMensajeDeudores = async (req, res) => {
  try {
    const now = new Date();
    const targetYear  = parseInt(req.body.ano)  || now.getFullYear();
    const targetMonth = parseInt(req.body.mes)  || (now.getMonth() + 1);
    const mensajeCustom = typeof req.body.mensaje === 'string' && req.body.mensaje.trim()
      ? req.body.mensaje.trim() : null;

    const dateExpr = `COALESCE(p.payment_date::timestamptz, p.validated_at, p.created_at)`;

    // Obtener clientes pendientes de pago del mes (solo DB local)
    const { rows: deudores } = await query(`
      WITH pagos_mes AS (
        SELECT DISTINCT COALESCE(p.client_id, conv.client_id) AS client_id
        FROM payments p
        LEFT JOIN conversations conv ON conv.id = p.conversation_id
        WHERE p.status = 'validated'
          AND EXTRACT(YEAR  FROM ${dateExpr}) = $1
          AND EXTRACT(MONTH FROM ${dateExpr}) = $2
          AND COALESCE(p.client_id, conv.client_id) IS NOT NULL
      )
      SELECT cl.id, cl.name, cl.phone, cl.plan_price
      FROM clients cl
      LEFT JOIN pagos_mes pm ON pm.client_id = cl.id
      WHERE cl.wisphub_id IS NOT NULL
        AND cl.phone IS NOT NULL AND cl.phone != ''
        AND pm.client_id IS NULL
      ORDER BY cl.name ASC
    `, [targetYear, targetMonth]);

    if (deudores.length === 0) {
      return res.json({ success: true, enviados: 0, errores: 0, total: 0, message: 'No hay clientes deudores este mes.' });
    }

    const mesesNombres = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const mesNombre = mesesNombres[targetMonth] || '';

    let enviados = 0;
    let errores  = 0;

    for (const d of deudores) {
      try {
        const nombre = d.name || 'Cliente';
        const precio = d.plan_price ? `S/ ${parseFloat(d.plan_price).toFixed(2)}` : 'su cuota mensual';

        const mensaje = mensajeCustom
          ? mensajeCustom.replace('{nombre}', nombre).replace('{precio}', precio)
          : `Estimado/a *${nombre}*, le recordamos que su pago de *${mesNombre}* de *${precio}* se encuentra pendiente.\n\nPor favor realice su pago para evitar inconvenientes con su servicio. 🙏\n\n_Fiber Perú_`;

        await whatsapp.sendTextMessage(d.phone, mensaje);
        enviados++;
        await new Promise(r => setTimeout(r, 400)); // pausa para evitar rate limiting
      } catch (err) {
        errores++;
        logger.warn('Error enviando mensaje a deudor', { phone: d.phone, error: err.message });
      }
    }

    logger.info(`Campaña deudores: ${enviados}/${deudores.length} enviados`, { targetYear, targetMonth });
    return res.json({
      success: true,
      enviados,
      errores,
      total: deudores.length,
      message: `Mensajes enviados: ${enviados} de ${deudores.length} deudores.`,
    });
  } catch (err) {
    logger.error('sendMensajeDeudores error', { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// MATRIZ DE PAGOS: clientes × últimos N meses
// Devuelve tabla completa para el historial mensual
// ─────────────────────────────────────────────────────────────
const MESES_SHORT = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const getMatrizPagos = async (req, res) => {
  try {
    const mesesAtras = Math.min(12, Math.max(1, parseInt(req.query.meses) || 6));
    const now = new Date();

    // Generar cabeceras de meses
    const meses = [];
    for (let i = mesesAtras - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      meses.push({
        key:            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        ano:            d.getFullYear(),
        mes:            d.getMonth() + 1,
        label:          MESES_SHORT[d.getMonth() + 1],
        labelFull:      `${MESES_ES[d.getMonth() + 1]} ${d.getFullYear()}`,
        isCurrentMonth: d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(),
      });
    }

    const startDate = new Date(now.getFullYear(), now.getMonth() - mesesAtras + 1, 1);
    const dateExpr  = `COALESCE(p.payment_date::timestamptz, p.validated_at, p.created_at)`;

    // Pagos validados en el período agrupados por cliente+mes
    const { rows: pagos } = await query(`
      SELECT
        COALESCE(p.client_id, conv.client_id)          AS client_id,
        EXTRACT(YEAR  FROM ${dateExpr})::int            AS ano,
        EXTRACT(MONTH FROM ${dateExpr})::int            AS mes,
        MAX(p.amount)                                   AS monto_pagado
      FROM payments p
      LEFT JOIN conversations conv ON conv.id = p.conversation_id
      WHERE p.status = 'validated'
        AND ${dateExpr} >= $1
        AND COALESCE(p.client_id, conv.client_id) IS NOT NULL
      GROUP BY COALESCE(p.client_id, conv.client_id),
               EXTRACT(YEAR FROM ${dateExpr}),
               EXTRACT(MONTH FROM ${dateExpr})
    `, [startDate.toISOString()]);

    // Mapa: clientId → { 'YYYY-MM': { estado, monto } }
    const pagoMap = {};
    for (const p of pagos) {
      if (!p.client_id) continue;
      if (!pagoMap[p.client_id]) pagoMap[p.client_id] = {};
      pagoMap[p.client_id][`${p.ano}-${String(p.mes).padStart(2, '0')}`] = {
        estado: 'pagado',
        monto: parseFloat(p.monto_pagado),
      };
    }

    const { rows: clientes } = await query(`
      SELECT id, wisphub_id, name, phone, plan, plan_price
      FROM clients
      WHERE wisphub_id IS NOT NULL AND phone IS NOT NULL AND phone != ''
      ORDER BY name ASC
    `);

    const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const matriz = clientes.map(cl => {
      const cp = pagoMap[cl.id] || {};
      const pagosRow = {};
      let mesesPagados = 0;
      let deudasAnteriores = 0;

      for (const m of meses) {
        pagosRow[m.key] = cp[m.key] || { estado: 'pendiente' };
        if (cp[m.key])              mesesPagados++;
        else if (!m.isCurrentMonth) deudasAnteriores++;
      }

      return {
        ...cl,
        pagos:              pagosRow,
        meses_pagados:      mesesPagados,
        meses_pendientes:   meses.length - mesesPagados,
        deuda_actual:       pagosRow[currentKey]?.estado === 'pendiente',
        deudas_anteriores:  deudasAnteriores,
        al_dia:             pagosRow[currentKey]?.estado === 'pagado',
      };
    });

    return res.json({ success: true, data: { matriz, meses } });
  } catch (err) {
    logger.error('getMatrizPagos error', { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// HISTORIAL COMPLETO DE UN CLIENTE
// ─────────────────────────────────────────────────────────────
const getHistorialCliente = async (req, res) => {
  try {
    const { clientId } = req.params;

    const { rows: clientRows } = await query(
      `SELECT id, wisphub_id, name, phone, plan, plan_price, service_status
       FROM clients WHERE id = $1`,
      [clientId]
    );
    if (!clientRows.length) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    const dateExpr = `COALESCE(p.payment_date::timestamptz, p.validated_at, p.created_at)`;

    const { rows: pagos } = await query(`
      SELECT
        p.id, p.amount, p.payment_method, p.payment_date,
        p.validated_at, p.created_at, p.operation_code,
        p.status, p.voucher_url,
        EXTRACT(YEAR  FROM ${dateExpr})::int AS ano,
        EXTRACT(MONTH FROM ${dateExpr})::int AS mes
      FROM payments p
      LEFT JOIN conversations conv ON conv.id = p.conversation_id
      WHERE (p.client_id = $1 OR conv.client_id = $1)
        AND p.status = 'validated'
      ORDER BY p.created_at DESC
    `, [clientId]);

    return res.json({ success: true, data: { cliente: clientRows[0], pagos } });
  } catch (err) {
    logger.error('getHistorialCliente error', { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  listBotPayments, reconcilePayments,
  listClientesMes, sendMensajeDeudores,
  getMatrizPagos, getHistorialCliente,
};
