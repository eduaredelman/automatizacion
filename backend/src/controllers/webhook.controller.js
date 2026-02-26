const { query } = require('../config/database');
const whatsapp = require('../services/whatsapp.service');
const ai = require('../services/ai.service');
const payment = require('../services/payment.service');
const wisphub = require('../services/wisphub.service');
const logger = require('../utils/logger');
const { getPaymentBlock } = require('../config/payment-info');

// ─────────────────────────────────────────────────────────────
// VERIFICAR WEBHOOK (GET)
// ─────────────────────────────────────────────────────────────

const verify = (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified ✅');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp webhook verification failed', { mode, token });
  return res.status(403).json({ error: 'Forbidden' });
};

// ─────────────────────────────────────────────────────────────
// RECIBIR MENSAJES (POST)
// ─────────────────────────────────────────────────────────────

const receive = async (req, res) => {
  // Responder a Meta INMEDIATAMENTE (timeout de 20s)
  res.status(200).json({ received: true });

  try {
    const parsed = whatsapp.parseWebhookPayload(req.body);
    if (!parsed) return;

    const { phone, displayName, messageId, type, text, mediaId, mediaMime, mediaCaption } = parsed;
    logger.info('📱 Mensaje entrante', { phone, type, messageId });

    // Marcar como leído
    await whatsapp.markAsRead(messageId).catch(() => {});

    // ── Upsert conversación ────────────────────────────────────
    const convResult = await query(
      `INSERT INTO conversations (phone, display_name, last_message, last_message_at, unread_count)
       VALUES ($1, $2, $3, NOW(), 1)
       ON CONFLICT (phone) DO UPDATE SET
         display_name     = COALESCE(NULLIF(EXCLUDED.display_name, phone), conversations.display_name),
         last_message     = EXCLUDED.last_message,
         last_message_at  = NOW(),
         unread_count     = conversations.unread_count + 1
       RETURNING *`,
      [phone, displayName, text || `[${type}]`]
    );
    const conversation = convResult.rows[0];

    // ── Guardar mensaje entrante ───────────────────────────────
    const msgResult = await query(
      `INSERT INTO messages
         (conversation_id, whatsapp_id, direction, sender_type, message_type, body, media_mime)
       VALUES ($1, $2, 'inbound', 'client', $3, $4, $5)
       ON CONFLICT (whatsapp_id) DO NOTHING
       RETURNING *`,
      [conversation.id, messageId, type, text || mediaCaption || null, mediaMime || null]
    );

    const message = msgResult.rows[0];
    if (!message) return; // Mensaje duplicado, ignorar

    // ── ¿Asesor en control? → no hacer nada (él responde) ─────
    if (conversation.status === 'human') {
      logger.info('👨‍💼 Modo humano activo, bot pausado', { phone });
      await emitSocketEvent('new_message', { conversation, message });
      return;
    }

    // ── Enrutar por tipo de mensaje ────────────────────────────
    if (type === 'image' && mediaId) {
      await handleImageMessage({ conversation, message, phone, mediaId });
    } else if (type === 'text' && text) {
      await handleTextMessage({ conversation, message, phone, text });
    } else {
      await whatsapp.sendTextMessage(phone,
        `📸 Puedes enviarme texto o la foto de tu comprobante de pago.\n\nMétodos aceptados:\n${getPaymentBlock()}`
      );
    }

    // Emitir al panel web en tiempo real
    await emitSocketEvent('new_message', { conversation, message });

  } catch (err) {
    logger.error('❌ Error en webhook', { error: err.message, stack: err.stack });
  }
};

// ─────────────────────────────────────────────────────────────
// MANEJAR IMAGEN (voucher de pago)
// ─────────────────────────────────────────────────────────────

const handleImageMessage = async ({ conversation, message, phone, mediaId }) => {
  try {
    // 1. Acuse de recibo inmediato
    await whatsapp.sendTextMessage(phone,
      '📸 Recibí tu comprobante. Analizando con IA... ⏳'
    );

    // 2. Descargar imagen
    const mediaInfo = await whatsapp.downloadMedia(mediaId);

    // 3. Actualizar mensaje con ruta del archivo
    await query(
      `UPDATE messages SET media_url = $1, media_filename = $2, media_size = $3 WHERE id = $4`,
      [mediaInfo.url, mediaInfo.filename, mediaInfo.size, message.id]
    );

    // 4. Analizar con IA Vision PRIMERO (más preciso)
    let visionResult = null;
    if (process.env.OPENAI_API_KEY) {
      visionResult = await ai.analyzeVoucherWithAI(mediaInfo.path);
    }

    // 5. Si IA Vision dice que no es un comprobante válido
    if (visionResult && !visionResult.is_valid_voucher) {
      const response = `❓ La imagen que enviaste no parece ser un comprobante de pago.

Por favor envía la captura de tu pago realizado por:
${getPaymentBlock()}

¿Tienes dudas? Responde este mensaje y te ayudo. 😊`;

      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // 6. Procesar el voucher (OCR + WispHub)
    const result = await payment.processVoucher({
      conversationId: conversation.id,
      messageId: message.id,
      imagePath: mediaInfo.path,
      clientPhone: phone,
      // Pasar datos de IA si ya los tenemos (para enriquecer el OCR)
      aiVisionData: visionResult,
    });

    // 7. Construir respuesta según resultado
    const responseText = buildPaymentResponse(result);
    await whatsapp.sendTextMessage(phone, responseText);
    await saveOutboundMessage(conversation.id, responseText, 'bot');

    // 8. Si hay error → escalar a humano
    if (['manual_review', 'error', 'client_not_found'].includes(result.status)) {
      await escalateToHuman(conversation, `Pago requiere revisión: ${result.status}`);
    }

    // 9. Log del evento
    await logEvent(conversation.id, result.paymentId, 'payment_processed', result.status);
    await emitSocketEvent('payment_update', { conversationId: conversation.id, status: result.status });

  } catch (err) {
    logger.error('❌ Error procesando imagen', { phone, error: err.message });
    const errorMsg = '❌ Ocurrió un error procesando tu comprobante. Un asesor lo revisará y te contactará pronto.';
    await whatsapp.sendTextMessage(phone, errorMsg).catch(() => {});
    await saveOutboundMessage(conversation.id, errorMsg, 'bot').catch(() => {});
    await escalateToHuman(conversation, 'Error procesando imagen').catch(() => {});
  }
};

// ─────────────────────────────────────────────────────────────
// MANEJAR TEXTO (chatbot con IA)
// ─────────────────────────────────────────────────────────────

const handleTextMessage = async ({ conversation, message, phone, text }) => {
  try {
    // 1. Obtener historial reciente para contexto
    const historyResult = await query(
      `SELECT sender_type, body FROM messages
       WHERE conversation_id = $1
         AND message_type = 'text'
         AND body IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 15`,
      [conversation.id]
    );
    const history = historyResult.rows.reverse();

    // 2. Obtener info del cliente — primero BD local, si no hay → WispHub
    let clientInfo = null;
    const clientResult = await query(
      `SELECT cl.name, cl.plan, cl.debt_amount
       FROM clients cl
       JOIN conversations c ON c.phone = cl.phone
       WHERE c.id = $1`,
      [conversation.id]
    );
    if (clientResult.rows.length) {
      clientInfo = clientResult.rows[0];
    } else {
      // Cliente no sincronizado aún → buscar en WispHub al vuelo
      try {
        const wispClient = await wisphub.buscarClientePorTelefono(phone);
        if (wispClient) {
          const clientId = String(wispClient.id_servicio || wispClient.id);
          const clientName = wispClient.nombre || wispClient.name || 'N/A';
          const clientPlan = wispClient.plan || wispClient.nombre_plan || null;

          // Guardar en BD local para próximas interacciones
          await query(
            `INSERT INTO clients (wisphub_id, phone, name, service_id, plan, last_synced_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (wisphub_id) DO UPDATE
               SET phone=$2, name=$3, service_id=$4, plan=$5, last_synced_at=NOW()`,
            [clientId, phone, clientName, clientId, clientPlan]
          );

          // Actualizar nombre real en la conversación (reemplaza el display name de WhatsApp)
          await query(
            `UPDATE conversations SET display_name = $1 WHERE id = $2`,
            [clientName, conversation.id]
          );

          clientInfo = { name: clientName, plan: clientPlan, debt_amount: null };
          logger.info('Cliente identificado desde WispHub', { phone, name: clientName, plan: clientPlan });
        } else {
          logger.info('Cliente no encontrado en WispHub', { phone });
        }
      } catch (wispErr) {
        logger.warn('No se pudo consultar WispHub para identificar cliente', { phone, error: wispErr.message });
      }
    }

    // 3. Detectar intención para casos especiales
    const intent = await ai.detectIntent(text, history);

    // 4. Auto-escalar reclamos a humano
    if (intent.intent === 'complaint' && intent.confidence > 0.6) {
      await escalateToHuman(conversation, 'Reclamo detectado automáticamente');
      const response = '😔 Lamento los inconvenientes. Un *asesor humano* revisará tu caso de inmediato. Por favor espera un momento. ⏳';
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // 5. Si piden hablar con humano → escalar
    const quiereHumano = /asesor|agente|humano|persona|hablar con alguien|no entiendo/i.test(text);
    if (quiereHumano) {
      await escalateToHuman(conversation, 'Cliente solicitó asesor humano');
      const response = '👨‍💼 Te voy a conectar con un asesor humano ahora mismo. Un momento por favor...';
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // 6. Generar respuesta con IA conversacional (GPT-4o)
    const aiResponse = await ai.generateConversationalResponse(text, history, clientInfo);

    await whatsapp.sendTextMessage(phone, aiResponse.text);
    await saveOutboundMessage(conversation.id, aiResponse.text, 'bot');

    // 7. Actualizar intención en conversación
    await query(
      `UPDATE conversations SET bot_intent = $1, last_message = $2, last_message_at = NOW() WHERE id = $3`,
      [intent.intent, aiResponse.text.substring(0, 100), conversation.id]
    );

    await logEvent(conversation.id, null, 'intent_detected', intent.intent);

  } catch (err) {
    logger.error('❌ Error procesando texto', { phone, error: err.message });
    const fallback = ai.getFallbackResponse('unknown');
    await whatsapp.sendTextMessage(phone, fallback).catch(() => {});
  }
};

// ─────────────────────────────────────────────────────────────
// RESPUESTA DE PAGO
// ─────────────────────────────────────────────────────────────

const buildPaymentResponse = (result) => {
  const ocr = result.ocrResult || {};
  const debt = result.debtInfo || {};

  switch (result.status) {
    case 'success':
      return `✅ *¡Pago registrado exitosamente!*

💰 Monto: *S/ ${ocr.amount || 'N/A'}*
🏦 Medio: ${ocr.paymentMethod || 'N/A'}
🔖 Operación: \`${ocr.operationCode || 'N/A'}\`
📅 Fecha: ${ocr.paymentDate || new Date().toLocaleDateString('es-PE')}

Tu servicio está activo. ¡Gracias por tu pago! 🙏`;

    case 'duplicate':
      return `⚠️ *Comprobante ya registrado*

El código de operación \`${ocr.operationCode}\` ya fue procesado anteriormente.

Si crees que es un error, un asesor te ayudará. 👨‍💼`;

    case 'unreadable':
      return `📸 *No pude leer el comprobante*

La imagen no es suficientemente clara. Por favor:
• Toma la foto con buena iluminación
• Que el monto y código sean visibles
• Sin sombras ni reflejos

Intenta de nuevo. 🔄`;

    case 'client_not_found':
      return `❓ *Cuenta no encontrada*

No encontré tu cuenta con este número de WhatsApp.

Posibles soluciones:
• Verifica que uses el número registrado en FiberPeru
• Escríbenos tu nombre completo y DNI para buscarte

Si ya pagaste, tu comprobante fue guardado y un asesor lo vinculará a tu cuenta. 👨‍💼`;

    case 'amount_mismatch':
      return `⚠️ *Monto no coincide*

💰 Tu pago: *S/ ${ocr.amount || 'N/A'}*
📋 Tu deuda actual: *S/ ${debt.monto_deuda || 'N/A'}*
📊 Diferencia: S/ ${result.difference?.toFixed(2) || 'N/A'}

Un asesor revisará tu caso. 👨‍💼`;

    case 'no_debt':
      return `✅ *Sin deuda pendiente*

No encontré facturas pendientes en tu cuenta en este momento.

¿Pagaste de más? ¿Tienes otra consulta? Responde este mensaje. 😊`;

    case 'manual_review':
      return `🔍 *En revisión manual*

Tu comprobante está siendo revisado por un asesor.
Te confirmaremos el registro muy pronto. ⏳

¿Tienes alguna consulta? Responde este mensaje.`;

    default:
      return `❌ *Error al procesar*

Ocurrió un problema con tu comprobante. Un asesor lo revisará y te contactará pronto. 👨‍💼`;
  }
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const escalateToHuman = async (conversation, reason = '') => {
  await query(
    `UPDATE conversations SET status = 'human' WHERE id = $1`,
    [conversation.id]
  );
  await logEvent(conversation.id, null, 'escalated_to_human', reason);
  await emitSocketEvent('conversation_update', {
    conversationId: conversation.id,
    status: 'human',
    reason,
  });
};

const saveOutboundMessage = (conversationId, body, senderType) => {
  return query(
    `INSERT INTO messages (conversation_id, direction, sender_type, message_type, body)
     VALUES ($1, 'outbound', $2, 'text', $3)`,
    [conversationId, senderType, body]
  );
};

const logEvent = (conversationId, paymentId, eventType, description) => {
  return query(
    `INSERT INTO events (conversation_id, payment_id, event_type, description)
     VALUES ($1, $2, $3, $4)`,
    [conversationId, paymentId || null, eventType, String(description)]
  ).catch(err => logger.warn('Log event failed', { error: err.message }));
};

const emitSocketEvent = async (event, data) => {
  try {
    const { emitToAgents, emitToConversation } = require('../config/socket');
    emitToAgents(event, data);
    // También emitir el mensaje a la sala de la conversación para
    // que ChatWindow lo reciba en tiempo real sin depender del layout
    if (event === 'new_message' && data.message?.conversation_id) {
      emitToConversation(data.message.conversation_id, 'message', data.message);
    }
  } catch {
    // Socket no crítico
  }
};

module.exports = { verify, receive };
