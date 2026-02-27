const path = require('path');
const { query } = require('../config/database');
const wisphub = require('./wisphub.service');
const ocr = require('./ocr.service');
const logger = require('../utils/logger');

const AMOUNT_TOLERANCE = 0.50;

const processVoucher = async ({ conversationId, messageId, imagePath, clientPhone, aiVisionData = null }) => {
  // Derivar la URL pública del archivo (para mostrar en el CRM)
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
    // 1. OCR + AI Vision Analysis
    // Si ya tenemos datos de IA Vision (del webhook), úsalos como base
    // Si el OCR da más datos, combinar ambos
    let ocrResult = await ocr.analyzeVoucher(imagePath);

    // Combinar: IA Vision gana en confianza, OCR puede complementar campos faltantes
    if (aiVisionData && aiVisionData.success) {
      const merged = {
        success: true,
        confidence: aiVisionData.confidence || ocrResult.confidence,
        method: 'ai_vision+ocr',
        paymentMethod: aiVisionData.paymentMethod !== 'unknown' ? aiVisionData.paymentMethod : ocrResult.paymentMethod,
        amount: aiVisionData.amount ?? ocrResult.amount,
        currency: aiVisionData.currency || ocrResult.currency || 'PEN',
        operationCode: aiVisionData.operationCode || ocrResult.operationCode,
        paymentDate: aiVisionData.paymentDate || ocrResult.paymentDate,
        paymentTime: aiVisionData.paymentTime || ocrResult.paymentTime,
        payerName: aiVisionData.payerName || ocrResult.payerName,
        phone: aiVisionData.phone || ocrResult.phone,
        cardLast4: aiVisionData.cardLast4 || ocrResult.cardLast4,
        rawData: { ai: aiVisionData.rawData, ocr: ocrResult.rawData },
      };
      ocrResult = merged;
      logger.info('Using merged AI Vision + OCR result', { confidence: merged.confidence, amount: merged.amount });
    }

    if (!ocrResult.success || ocrResult.confidence === 'none') {
      // Si no hay datos de IA Vision → el comprobante queda para revisión manual (no hay OCR automático)
      const reason = aiVisionData ? 'No se pudo leer el comprobante claramente' : 'Sin procesamiento automático - revisión manual requerida';
      const newStatus = aiVisionData ? 'rejected' : 'manual_review';
      const retStatus = aiVisionData ? 'unreadable' : 'manual_review';
      await updatePayment({ status: newStatus, rejection_reason: reason, ocr_confidence: 'none' });
      return { status: retStatus, paymentId };
    }

    // 2. Store OCR data
    await updatePayment({
      payment_method: ocrResult.paymentMethod,
      amount: ocrResult.amount,
      currency: ocrResult.currency,
      operation_code: ocrResult.operationCode,
      payment_date: ocrResult.paymentDate,
      payer_name: ocrResult.payerName,
      ocr_confidence: ocrResult.confidence,
      ocr_raw: JSON.stringify(ocrResult.rawData || {}),
      status: 'processing',
    });

    // 3. Duplicate check
    if (ocrResult.operationCode) {
      const dup = await query(
        `SELECT id FROM payments WHERE operation_code = $1 AND id != $2 AND status = 'validated'`,
        [ocrResult.operationCode, paymentId]
      );
      if (dup.rows.length > 0) {
        await updatePayment({ status: 'duplicate', rejection_reason: `Código duplicado: ${ocrResult.operationCode}` });
        return { status: 'duplicate', paymentId, ocrResult };
      }
    }

    // 4. Find client in WispHub
    const client = await wisphub.buscarCliente(clientPhone, ocrResult.payerName);
    if (!client) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'Cliente no encontrado en el sistema' });
      return { status: 'client_not_found', paymentId, ocrResult };
    }

    const clientId = client.id_servicio || client.id;

    // Upsert client in local DB
    await query(
      `INSERT INTO clients (wisphub_id, phone, name, service_id, last_synced_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (wisphub_id) DO UPDATE SET phone=$2, name=$3, service_id=$4, last_synced_at=NOW()`,
      [String(clientId), clientPhone, client.nombre || client.name || 'N/A', String(clientId)]
    );

    // 5. Check debt
    const debtInfo = await wisphub.consultarDeuda(clientId);
    await updatePayment({ debt_amount: debtInfo.monto_deuda });

    if (!debtInfo.tiene_deuda) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'Sin facturas pendientes' });
      return { status: 'no_debt', paymentId, ocrResult, debtInfo };
    }

    // 6. Validate amount
    const diff = Math.abs((ocrResult.amount || 0) - debtInfo.monto_deuda);
    await updatePayment({ amount_difference: diff });

    if (diff > AMOUNT_TOLERANCE) {
      await updatePayment({
        status: 'rejected',
        rejection_reason: `Monto no coincide. Deuda: S/${debtInfo.monto_deuda}, Pagado: S/${ocrResult.amount}`,
      });
      return { status: 'amount_mismatch', paymentId, ocrResult, debtInfo, difference: diff };
    }

    // 7. Register payment in WispHub
    const wispResult = await wisphub.registrarPago(clientId, {
      amount: ocrResult.amount,
      date: ocrResult.paymentDate || new Date().toISOString().split('T')[0],
      method: ocrResult.paymentMethod,
      operationCode: ocrResult.operationCode || `AUTO-${Date.now()}`,
    });

    if (debtInfo.factura_id) {
      await wisphub.marcarFacturaPagada(debtInfo.factura_id).catch(err => {
        logger.warn('Could not mark invoice paid', { facturaId: debtInfo.factura_id, err: err.message });
      });
    }

    // 8. Mark as validated
    await updatePayment({
      status: 'validated',
      registered_wisphub: true,
      wisphub_payment_id: String(wispResult?.id || ''),
      factura_id: String(debtInfo.factura_id || ''),
      validated_at: new Date().toISOString(),
    });

    logger.info('Payment validated', { conversationId, amount: ocrResult.amount, clientId });
    return { status: 'success', paymentId, ocrResult, debtInfo, wispResult };

  } catch (err) {
    logger.error('Payment processing error', { conversationId, error: err.message });
    await updatePayment({
      status: 'manual_review',
      rejection_reason: `Error: ${err.message}`,
    }).catch(() => {});
    return { status: 'error', error: err.message, paymentId };
  }
};

module.exports = { processVoucher };
