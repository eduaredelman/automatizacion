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
const finalizePendingVoucher = async (paymentId, clientPhone) => {
  const { rows: [pmtRow] } = await query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!pmtRow) throw new Error(`Payment ${paymentId} not found`);

  const aiVisionData = pmtRow.ocr_raw ? JSON.parse(pmtRow.ocr_raw) : null;

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

    // Duplicate check
    if (aiVisionData.operationCode) {
      const dup = await query(
        `SELECT id FROM payments WHERE operation_code = $1 AND id != $2 AND status = 'validated'`,
        [aiVisionData.operationCode, paymentId]
      );
      if (dup.rows.length > 0) {
        await updatePayment({ status: 'duplicate', rejection_reason: `Código duplicado: ${aiVisionData.operationCode}` });
        return { status: 'duplicate', paymentId };
      }
    }

    // WispHub client lookup
    const client = await wisphub.buscarCliente(clientPhone, aiVisionData.payerName);
    if (!client) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'Cliente no encontrado en el sistema' });
      return { status: 'client_not_found', paymentId };
    }

    const clientId = client.id_servicio || client.id;

    await query(
      `INSERT INTO clients (wisphub_id, phone, name, service_id, last_synced_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (wisphub_id) DO UPDATE SET phone=$2, name=$3, service_id=$4, last_synced_at=NOW()`,
      [String(clientId), clientPhone, client.nombre || client.name || 'N/A', String(clientId)]
    );

    // Debt check
    const debtInfo = await wisphub.consultarDeuda(clientId);
    await updatePayment({ debt_amount: debtInfo.monto_deuda });

    if (!debtInfo.tiene_deuda) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'Sin facturas pendientes en el sistema' });
      return { status: 'no_debt', paymentId, aiVisionData, debtInfo };
    }

    // Amount validation
    const diff = Math.abs(aiVisionData.amount - debtInfo.monto_deuda);
    await updatePayment({ amount_difference: diff });

    if (diff > AMOUNT_TOLERANCE) {
      await updatePayment({
        status: 'rejected',
        rejection_reason: `Monto no coincide. Deuda: S/${debtInfo.monto_deuda}, Comprobante: S/${aiVisionData.amount}`,
      });
      return { status: 'amount_mismatch', paymentId, aiVisionData, debtInfo, difference: diff };
    }

    // Register in WispHub
    const wispResult = await wisphub.registrarPago(clientId, {
      amount: aiVisionData.amount,
      date: aiVisionData.paymentDate || new Date().toISOString().split('T')[0],
      method: aiVisionData.paymentMethod !== 'unknown' ? aiVisionData.paymentMethod : 'transferencia',
      operationCode: aiVisionData.operationCode || `AUTO-${Date.now()}`,
    });

    if (debtInfo.factura_id) {
      await wisphub.marcarFacturaPagada(debtInfo.factura_id).catch(err => {
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

    logger.info('Payment validated', { paymentId, amount: aiVisionData.amount, clientId });
    return { status: 'success', paymentId, aiVisionData, debtInfo, wispResult };

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
// (usado cuando identidad ya está confirmada al llegar la imagen)
// ─────────────────────────────────────────────────────────────
const processVoucher = async ({ conversationId, messageId, imagePath, clientPhone, aiVisionData = null }) => {
  const paymentId = await savePendingVoucher({ conversationId, messageId, imagePath, aiVisionData });
  return finalizePendingVoucher(paymentId, clientPhone);
};

module.exports = { processVoucher, savePendingVoucher, finalizePendingVoucher };
