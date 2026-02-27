const path = require('path');
const { query } = require('../config/database');
const wisphub = require('./wisphub.service');
const logger = require('../utils/logger');

const AMOUNT_TOLERANCE = 0.50;

const processVoucher = async ({ conversationId, messageId, imagePath, clientPhone, aiVisionData = null }) => {
  const voucherUrl = '/uploads/' + path.basename(imagePath);

  // Create pending payment record
  const { rows: [paymentRow] } = await query(
    `INSERT INTO payments (conversation_id, message_id, voucher_path, voucher_url, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
    [conversationId, messageId, imagePath, voucherUrl]
  );
  const paymentId = paymentRow.id;

  const updatePayment = (fields) => {
    const keys = Object.keys(fields);
    const vals = Object.values(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    return query(`UPDATE payments SET ${set}, updated_at = NOW() WHERE id = $1`, [paymentId, ...vals]);
  };

  try {
    // 1. AI Vision es la única fuente de verdad (OCR stub eliminado)
    if (!aiVisionData || !aiVisionData.success) {
      await updatePayment({
        status: 'manual_review',
        rejection_reason: 'No se pudo analizar el comprobante automáticamente. Un agente lo revisará.',
        ocr_confidence: 'none',
      });
      return { status: 'manual_review', paymentId };
    }

    logger.info('AI Vision data received', {
      confidence: aiVisionData.confidence,
      amount: aiVisionData.amount,
      method: aiVisionData.paymentMethod,
    });

    // 2. Guardar datos de AI Vision en el registro
    await updatePayment({
      payment_method: aiVisionData.paymentMethod !== 'unknown' ? aiVisionData.paymentMethod : null,
      amount: aiVisionData.amount,
      currency: aiVisionData.currency || 'PEN',
      operation_code: aiVisionData.operationCode,
      payment_date: aiVisionData.paymentDate,
      payer_name: aiVisionData.payerName,
      ocr_confidence: aiVisionData.confidence,
      ocr_raw: JSON.stringify(aiVisionData.rawData || {}),
      status: 'processing',
    });

    // 3. Verificar monto extraído
    if (aiVisionData.amount === null || aiVisionData.amount === undefined) {
      await updatePayment({
        status: 'manual_review',
        rejection_reason: 'No se pudo extraer el monto del comprobante. Un agente lo revisará.',
      });
      return { status: 'manual_review', paymentId, aiVisionData };
    }

    // 4. Detección de duplicados por código de operación
    if (aiVisionData.operationCode) {
      const dup = await query(
        `SELECT id FROM payments WHERE operation_code = $1 AND id != $2 AND status = 'validated'`,
        [aiVisionData.operationCode, paymentId]
      );
      if (dup.rows.length > 0) {
        await updatePayment({ status: 'duplicate', rejection_reason: `Código duplicado: ${aiVisionData.operationCode}` });
        return { status: 'duplicate', paymentId, aiVisionData };
      }
    }

    // 5. Buscar cliente en WispHub
    const client = await wisphub.buscarCliente(clientPhone, aiVisionData.payerName);
    if (!client) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'Cliente no encontrado en el sistema' });
      return { status: 'client_not_found', paymentId, aiVisionData };
    }

    const clientId = client.id_servicio || client.id;

    await query(
      `INSERT INTO clients (wisphub_id, phone, name, service_id, last_synced_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (wisphub_id) DO UPDATE SET phone=$2, name=$3, service_id=$4, last_synced_at=NOW()`,
      [String(clientId), clientPhone, client.nombre || client.name || 'N/A', String(clientId)]
    );

    // 6. Consultar deuda
    const debtInfo = await wisphub.consultarDeuda(clientId);
    await updatePayment({ debt_amount: debtInfo.monto_deuda });

    if (!debtInfo.tiene_deuda) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'Sin facturas pendientes en el sistema' });
      return { status: 'no_debt', paymentId, aiVisionData, debtInfo };
    }

    // 7. Validar monto
    const diff = Math.abs(aiVisionData.amount - debtInfo.monto_deuda);
    await updatePayment({ amount_difference: diff });

    if (diff > AMOUNT_TOLERANCE) {
      await updatePayment({
        status: 'rejected',
        rejection_reason: `Monto no coincide. Deuda: S/${debtInfo.monto_deuda}, Comprobante: S/${aiVisionData.amount}`,
      });
      return { status: 'amount_mismatch', paymentId, aiVisionData, debtInfo, difference: diff };
    }

    // 8. Registrar pago en WispHub
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

    // 9. Marcar como validado
    await updatePayment({
      status: 'validated',
      registered_wisphub: true,
      wisphub_payment_id: String(wispResult?.id || ''),
      factura_id: String(debtInfo.factura_id || ''),
      validated_at: new Date().toISOString(),
    });

    logger.info('Payment validated via AI Vision', { conversationId, amount: aiVisionData.amount, clientId });
    return { status: 'success', paymentId, aiVisionData, debtInfo, wispResult };

  } catch (err) {
    logger.error('Payment processing error', { conversationId, error: err.message });
    await updatePayment({
      status: 'manual_review',
      rejection_reason: `Error al procesar: ${err.message}`,
    }).catch(() => {});
    return { status: 'error', error: err.message, paymentId };
  }
};

module.exports = { processVoucher };
