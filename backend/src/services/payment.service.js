const path = require('path');
const { query, getClient } = require('../config/database');
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
// Se llama DESPUÉS de confirmar identidad del cliente.
// Usa transacción + SELECT FOR UPDATE para garantizar que:
//  - Nunca se procesa el mismo pago dos veces concurrentemente
//  - Si algo falla a mitad, no quedan datos a medio actualizar
// ─────────────────────────────────────────────────────────────
const finalizePendingVoucher = async (paymentId, clientPhone, wisphubClientId = null) => {
  const dbClient = await getClient();

  // Helper que usa el cliente de transacción
  const updatePayment = async (fields) => {
    const keys = Object.keys(fields);
    const vals = Object.values(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await dbClient.query(`UPDATE payments SET ${set}, updated_at = NOW() WHERE id = $1`, [paymentId, ...vals]);
  };

  try {
    await dbClient.query('BEGIN');

    // Bloquear la fila para evitar procesamiento concurrente del mismo pago
    const { rows: [pmtRow] } = await dbClient.query(
      'SELECT * FROM payments WHERE id = $1 FOR UPDATE',
      [paymentId]
    );
    if (!pmtRow) {
      await dbClient.query('ROLLBACK');
      throw new Error(`Payment ${paymentId} not found`);
    }

    // Idempotencia: si ya fue procesado, no volver a procesar
    if (['validated', 'rejected', 'duplicate'].includes(pmtRow.status)) {
      await dbClient.query('ROLLBACK');
      logger.info('Payment already processed, skipping', { paymentId, status: pmtRow.status });
      return { status: pmtRow.status, paymentId };
    }

    // FIX: PostgreSQL JSONB devuelve objeto ya parseado; JSON.parse() sobre objeto falla.
    let aiVisionData = null;
    try {
      const raw = pmtRow.ocr_raw;
      if (raw) aiVisionData = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (parseErr) {
      logger.error('Failed to parse ocr_raw', { paymentId, error: parseErr.message });
    }

    if (!aiVisionData || !aiVisionData.success) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'No se pudo analizar el comprobante automáticamente.', ocr_confidence: 'none' });
      await dbClient.query('COMMIT');
      return { status: 'manual_review', paymentId };
    }

    logger.info('AI Vision data received', {
      confidence: aiVisionData.confidence,
      amount: aiVisionData.amount,
      voucherStatus: aiVisionData.voucherStatus,
      yearDetected: aiVisionData.yearDetected,
      monthDetected: aiVisionData.monthDetected,
      fraudDetected: aiVisionData.fraudDetected,
    });

    // ── Detección de fraude: comprobante de año anterior o fecha futura ──────
    if (aiVisionData.fraudDetected || aiVisionData.futureDateFound) {
      const motivo = aiVisionData.futureDateFound
        ? `Fecha futura detectada en el comprobante (${aiVisionData.paymentDate}). No se aceptan pagos con fecha futura.`
        : `Comprobante de año anterior detectado (${aiVisionData.yearDetected || 'desconocido'}). Solo se aceptan comprobantes del año actual.`;
      logger.warn('Fraude detectado en comprobante', { paymentId, motivo, voucherStatus: aiVisionData.voucherStatus });
      await updatePayment({ status: 'rejected', rejection_reason: `⚠️ COMPROBANTE INVÁLIDO: ${motivo}` });
      await dbClient.query('COMMIT');
      return { status: 'fraud_detected', paymentId, aiVisionData, reason: motivo };
    }

    // ── Mes diferente: válido pero corresponde a otro mes ───────────────────
    if (aiVisionData.voucherStatus === 'MES_DIFERENTE' && aiVisionData.monthDetected) {
      logger.info('Comprobante de mes diferente al actual', {
        paymentId, mesDetectado: aiVisionData.monthDetected, razon: aiVisionData.voucherStatusReason,
      });
    }

    if (aiVisionData.amount === null || aiVisionData.amount === undefined) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'No se pudo extraer el monto del comprobante.' });
      await dbClient.query('COMMIT');
      return { status: 'manual_review', paymentId, aiVisionData };
    }

    // Duplicate check dentro de la transacción
    if (aiVisionData.operationCode) {
      const dup = await dbClient.query(
        `SELECT id, created_at, amount FROM payments WHERE operation_code = $1 AND id != $2 AND status = 'validated'`,
        [aiVisionData.operationCode, paymentId]
      );
      if (dup.rows.length > 0) {
        const original = dup.rows[0];
        await updatePayment({
          status: 'duplicate',
          rejection_reason: `Comprobante duplicado. Código: ${aiVisionData.operationCode} | Pago original ID: ${original.id}`,
        });
        await dbClient.query('COMMIT');
        return { status: 'duplicate', paymentId, originalPaymentId: original.id };
      }
    }

    // Buscar cliente en DB local
    let clientId = null;
    let localDbClientId = null;

    if (wisphubClientId) {
      clientId = wisphubClientId;
      logger.info('Usando wisphub_id confirmado para pago', { wisphubClientId });
      const localRow = await dbClient.query('SELECT id FROM clients WHERE wisphub_id = $1', [String(clientId)]);
      if (localRow.rows.length) localDbClientId = localRow.rows[0].id;
    } else {
      const phoneDigits = clientPhone.replace(/\D/g, '');
      const phoneVariants = [...new Set([
        phoneDigits,
        phoneDigits.startsWith('51') ? phoneDigits.slice(2) : phoneDigits,
        phoneDigits.startsWith('51') ? phoneDigits : `51${phoneDigits}`,
      ])].filter(p => p.length >= 7);

      const localClient = await dbClient.query(
        `SELECT id, wisphub_id FROM clients WHERE phone = ANY($1::text[]) AND wisphub_id IS NOT NULL LIMIT 1`,
        [phoneVariants]
      );

      if (!localClient.rows.length) {
        logger.warn('Cliente no encontrado en DB local para pago', { clientPhone });
        await updatePayment({ status: 'manual_review', rejection_reason: 'Cliente no encontrado en sistema. No existe en la base de datos sincronizada.' });
        await dbClient.query('COMMIT');
        return { status: 'client_not_found', paymentId };
      }

      clientId = localClient.rows[0].wisphub_id;
      localDbClientId = localClient.rows[0].id;
      logger.info('Cliente encontrado en DB local por teléfono', { clientPhone, wisphubId: clientId });
    }

    if (!clientId) {
      await updatePayment({ status: 'manual_review', rejection_reason: 'ID de cliente inválido' });
      await dbClient.query('COMMIT');
      return { status: 'client_not_found', paymentId };
    }

    // Obtener plan_price del cliente
    let planPrice = null;
    let wisphubUsuario = null;
    const planRow = await dbClient.query(
      "SELECT plan_price, wisphub_raw->>'usuario' as wisphub_usuario FROM clients WHERE wisphub_id = $1",
      [String(clientId)]
    );
    planPrice = parseFloat(planRow.rows[0]?.plan_price) || null;
    wisphubUsuario = planRow.rows[0]?.wisphub_usuario || null;

    const monthlyAmount = planPrice || 0;
    const debtInfo = {
      tiene_deuda:       monthlyAmount > 0,
      monto_deuda:       monthlyAmount,
      monto_mensual:     monthlyAmount,
      cantidad_facturas: 0,
      factura_id:        null,
      facturas:          [],
    };

    logger.info('Amount validation (DB local)', {
      clientId, planPrice, voucher: aiVisionData.amount, monthly: monthlyAmount,
    });

    if (monthlyAmount > 0) {
      const diff = Math.abs(aiVisionData.amount - monthlyAmount);
      if (diff > AMOUNT_TOLERANCE) {
        // Un solo UPDATE con todos los campos de rechazo — atómico
        await updatePayment({
          status: 'rejected',
          rejection_reason: `Monto no coincide. Cuota mensual: S/${monthlyAmount}, Comprobante: S/${aiVisionData.amount}`,
          client_id: localDbClientId,
          debt_amount: monthlyAmount,
          amount_difference: diff,
        });
        await dbClient.query('COMMIT');
        return { status: 'amount_mismatch', paymentId, aiVisionData, debtInfo, difference: diff };
      }
    }

    // Todos los datos de validación están listos — marcar como 'validated' en la transacción.
    // La llamada a WispHub va FUERA de la transacción para no tener un lock abierto durante
    // una llamada de red (podría tardar varios segundos).
    await updatePayment({
      status: 'validated',
      client_id: localDbClientId,
      debt_amount: monthlyAmount,
      amount_difference: monthlyAmount > 0 ? Math.abs(aiVisionData.amount - monthlyAmount) : null,
      registered_wisphub: false,
      validated_at: new Date().toISOString(),
    });

    await dbClient.query('COMMIT');

    // ── Post-commit: registrar en WispHub (no fatal, sin lock de BD abierto) ──
    let wispResult = null;
    try {
      wispResult = await wisphub.registrarPago(clientId, {
        amount: aiVisionData.amount,
        paymentDate: aiVisionData.paymentDate || new Date().toISOString().split('T')[0],
        method: aiVisionData.paymentMethod !== 'unknown' ? aiVisionData.paymentMethod : 'transferencia',
        operationCode: aiVisionData.operationCode || `AUTO-${Date.now()}`,
        facturaId: null,
        clientUsuario: wisphubUsuario,
      });

      // Actualizar registered_wisphub en una query simple (ya fuera de la transacción)
      await query(
        `UPDATE payments SET registered_wisphub = true, wisphub_payment_id = $2, factura_id = $3, updated_at = NOW() WHERE id = $1`,
        [paymentId, String(wispResult?.id || ''), '']
      );
    } catch (regErr) {
      logger.warn('WispHub registrarPago falló (no fatal)', {
        clientId,
        error: regErr.message,
        status: regErr.response?.status,
        wisphubResponse: JSON.stringify(regErr.response?.data || {}).substring(0, 400),
      });
      // El pago ya está marcado validated + registered_wisphub=false
      // El endpoint /reconcile lo sincronizará más adelante
    }

    logger.info('Payment validated', { paymentId, amount: aiVisionData.amount, clientId, registradoEnWisphub: !!wispResult });

    const finalStatus = debtInfo.tiene_deuda ? 'success' : 'registered_no_debt';
    return { status: finalStatus, paymentId, aiVisionData, debtInfo, wispResult };

  } catch (err) {
    await dbClient.query('ROLLBACK').catch(() => {});
    logger.error('Payment finalization error', { paymentId, error: err.message });
    // Best-effort: marcar como manual_review solo si sigue en pending
    query(
      `UPDATE payments SET status = 'manual_review', rejection_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [paymentId, `Error al procesar: ${err.message}`]
    ).catch(() => {});
    return { status: 'error', error: err.message, paymentId };
  } finally {
    dbClient.release();
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
