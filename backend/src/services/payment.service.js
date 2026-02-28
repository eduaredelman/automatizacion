const path = require('path');
const { query } = require('../config/database');
const wisphub = require('./wisphub.service');
const logger = require('../utils/logger');

const AMOUNT_TOLERANCE = 0.50;

// ─────────────────────────────────────────────────────────────
// PASO 1: Guardar voucher como pendiente (sin validar aún)
// Se llama cuando llega la imagen, ANTES de confirmar identidad
// ─────────────────────────────────────────────────────────────
const savePendingVoucher = async ({ conversationId, messageId, imagePath, aiVisionData }) => {
  const voucherUrl = '/uploads/' + path.basename(imagePath);
  const { rows: [row] } = await query(
    `INSERT INTO payments (
       conversation_id, message_id, voucher_path, voucher_url, status,
       payment_method, amount, currency, operation_code, payment_date,
       payer_name, ocr_confidence, ocr_raw
     ) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      conversationId, messageId, imagePath, voucherUrl,
      aiVisionData?.paymentMethod !== 'unknown' ? aiVisionData?.paymentMethod : null,
      aiVisionData?.amount,
      aiVisionData?.currency || 'PEN',
      aiVisionData?.operationCode,
      aiVisionData?.paymentDate,
      aiVisionData?.payerName,
      aiVisionData?.confidence,
      JSON.stringify(aiVisionData || {}),
    ]
  );
  return row.id;
};

// ─────────────────────────────────────────────────────────────
// PASO 2: Validar y registrar pago en WispHub
// Se llama DESPUÉS de confirmar identidad del cliente
// ─────────────────────────────────────────────────────────────
const finalizePendingVoucher = async (paymentId, clientPhone, wisphubClientId = null) => {
  const { rows: [pmtRow] } = await query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!pmtRow) throw new Error(`Payment ${paymentId} not found`);

  // FIX: PostgreSQL JSONB devuelve objeto ya parseado; JSON.parse() sobre objeto falla.
  // Manejar ambos casos: string (texto plano) y objeto (JSONB auto-parseado).
  let aiVisionData = null;
  try {
    const raw = pmtRow.ocr_raw;
    if (raw) {
      aiVisionData = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
  } catch (parseErr) {
    logger.error('Failed to parse ocr_raw', { paymentId, error: parseErr.message });
    aiVisionData = null;
  }

  const updatePayment = (fields) => {
    const keys = Object.keys(fields);
    const vals = Object.values(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    return query(`UPDATE payments SET ${set}, updated_at = NOW() WHERE id = $1`, [paymentId, ...vals]);
  };

  try {
    if (!aiVisionData || !aiVisionData.success) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'No se pudo analizar el comprobante automáticamente.', ocr_confidence: 'none' });
      return { status: 'manual_review', paymentId };
    }

    logger.info('AI Vision data received', { confidence: aiVisionData.confidence, amount: aiVisionData.amount });

    if (aiVisionData.amount === null || aiVisionData.amount === undefined) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'No se pudo extraer el monto del comprobante.' });
      return { status: 'manual_review', paymentId, aiVisionData };
    }

    // Duplicate check — guarda también el ID del pago original para mostrar en el CRM
    if (aiVisionData.operationCode) {
      const dup = await query(
        `SELECT id, created_at, amount FROM payments WHERE operation_code = $1 AND id != $2 AND status = 'validated'`,
        [aiVisionData.operationCode, paymentId]
      );
      if (dup.rows.length > 0) {
        const original = dup.rows[0];
        await updatePayment({
          status: 'duplicate',
          rejection_reason: `Comprobante duplicado. Código: ${aiVisionData.operationCode} | Pago original ID: ${original.id}`,
        });
        return { status: 'duplicate', paymentId, originalPaymentId: original.id };
      }
    }

    // WispHub client lookup
    let client = null;
    let clientId = null;

    if (wisphubClientId) {
      clientId = wisphubClientId;
      client = { id_servicio: wisphubClientId, id: wisphubClientId };
      logger.info('Using confirmed WispHub client ID for payment', { wisphubClientId });
    } else {
      client = await wisphub.buscarCliente(clientPhone, aiVisionData.payerName);
      if (!client) {
        await updatePayment({ status: 'manual_review', rejection_reason: 'Cliente no encontrado en el sistema' });
        return { status: 'client_not_found', paymentId };
      }
      clientId = client.id_servicio || client.id;
    }

    if (!clientId) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'ID de cliente inválido' });
      return { status: 'client_not_found', paymentId };
    }

    // Upsert cliente (sin sobreescribir nombre cuando ya está confirmado)
    if (wisphubClientId) {
      await query(
        `INSERT INTO clients (wisphub_id, phone, service_id, last_synced_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (wisphub_id) DO UPDATE SET phone=$2, last_synced_at=NOW()`,
        [String(clientId), clientPhone, String(clientId)]
      );
    } else {
      await query(
        `INSERT INTO clients (wisphub_id, phone, name, service_id, last_synced_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (wisphub_id) DO UPDATE SET phone=$2, name=$3, service_id=$4, last_synced_at=NOW()`,
        [String(clientId), clientPhone, client.nombre || client.name || 'N/A', String(clientId)]
      );
    }

    // Consultar deuda — pasar nombre del cliente para validar facturas
    // (payment.service no tiene wispClient, lo buscamos en clients local)
    let debtOpts = {};
    try {
      const clientRow = await query(
        'SELECT name FROM clients WHERE wisphub_id = $1',
        [String(clientId)]
      );
      if (clientRow.rows[0]?.name) debtOpts.nombre = clientRow.rows[0].name;
    } catch {}
    const debtInfo = await wisphub.consultarDeuda(clientId, debtOpts);
    await updatePayment({ debt_amount: debtInfo.monto_deuda });

    logger.info('Debt info', { clientId, tiene_deuda: debtInfo.tiene_deuda, monto: debtInfo.monto_deuda });

    // Si tiene deuda, validar que el monto coincida con la cuota mensual O con el total
    // (el cliente puede pagar 1 mes o todo de golpe)
    if (debtInfo.tiene_deuda) {
      const monthlyAmount = debtInfo.monto_mensual || 0;
      const totalAmount   = debtInfo.monto_deuda;

      const diffMonthly = monthlyAmount > 0
        ? Math.abs(aiVisionData.amount - monthlyAmount)
        : Infinity;
      const diffTotal = Math.abs(aiVisionData.amount - totalAmount);

      // Aceptar si coincide con la cuota mensual O con el total acumulado
      const diff = Math.min(diffMonthly, diffTotal);
      await updatePayment({ amount_difference: diff });

      logger.info('Amount validation', {
        voucher: aiVisionData.amount,
        monthly: monthlyAmount,
        total: totalAmount,
        diffMonthly,
        diffTotal,
        diff,
        tolerance: AMOUNT_TOLERANCE,
      });

      if (diff > AMOUNT_TOLERANCE) {
        await updatePayment({
          status: 'rejected',
          rejection_reason: `Monto no coincide. Cuota mensual: S/${monthlyAmount}, Total deuda: S/${totalAmount}, Comprobante: S/${aiVisionData.amount}`,
        });
        return { status: 'amount_mismatch', paymentId, aiVisionData, debtInfo, difference: diff };
      }
    }

    // Intentar registrar pago en WispHub (no fatal — el endpoint /pagos/ puede no existir en todos los planes)
    let wispResult = null;
    try {
      wispResult = await wisphub.registrarPago(clientId, {
        amount: aiVisionData.amount,
        date: aiVisionData.paymentDate || new Date().toISOString().split('T')[0],
        method: aiVisionData.paymentMethod !== 'unknown' ? aiVisionData.paymentMethod : 'transferencia',
        operationCode: aiVisionData.operationCode || `AUTO-${Date.now()}`,
      });
    } catch (regErr) {
      logger.warn('WispHub registrarPago falló (no fatal) — se marcará la factura como pagada igualmente', {
        clientId, error: regErr.message,
      });
    }

    // Marcar factura como pagada (SIEMPRE que haya factura_id — este endpoint sí funciona)
    if (debtInfo.factura_id) {
      await wisphub.marcarFacturaPagada(debtInfo.factura_id, {
        amount: aiVisionData.amount,
        date: aiVisionData.paymentDate || new Date().toISOString().split('T')[0],
        method: aiVisionData.paymentMethod !== 'unknown' ? aiVisionData.paymentMethod : 'transferencia',
        operationCode: aiVisionData.operationCode,
      }).catch(err => {
        logger.warn('Could not mark invoice paid', { facturaId: debtInfo.factura_id, err: err.message });
      });
    }

    await updatePayment({
      status: 'validated',
      registered_wisphub: true,
      wisphub_payment_id: String(wispResult?.id || ''),
      factura_id: String(debtInfo.factura_id || ''),
      validated_at: new Date().toISOString(),
    });

    logger.info('Payment validated and registered in WispHub', { paymentId, amount: aiVisionData.amount, clientId });

    // Retornar status diferente si no había deuda (para que el bot avise de manera distinta)
    const finalStatus = debtInfo.tiene_deuda ? 'success' : 'registered_no_debt';
    return { status: finalStatus, paymentId, aiVisionData, debtInfo, wispResult };

  } catch (err) {
    logger.error('Payment finalization error', { paymentId, error: err.message });
    await updatePayment({
      status: 'manual_review',
      rejection_reason: `Error al procesar: ${err.message}`,
    }).catch(() => {});
    return { status: 'error', error: err.message, paymentId };
  }
};

// ─────────────────────────────────────────────────────────────
// Mantener compatibilidad: flujo completo en un solo paso
// ─────────────────────────────────────────────────────────────
const processVoucher = async ({ conversationId, messageId, imagePath, clientPhone, aiVisionData = null }) => {
  const paymentId = await savePendingVoucher({ conversationId, messageId, imagePath, aiVisionData });
  return finalizePendingVoucher(paymentId, clientPhone);
};

module.exports = { processVoucher, savePendingVoucher, finalizePendingVoucher };
