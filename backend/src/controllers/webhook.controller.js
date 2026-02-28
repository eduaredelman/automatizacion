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
  res.status(200).json({ received: true });

  try {
    const parsed = whatsapp.parseWebhookPayload(req.body);
    if (!parsed) return;

    const { phone, displayName, messageId, type, text, mediaId, mediaMime, mediaCaption } = parsed;
    logger.info('📱 Mensaje entrante', { phone, type, messageId });

    await whatsapp.markAsRead(messageId).catch(() => {});

    // Upsert conversación
    const convResult = await query(
      `INSERT INTO conversations (phone, display_name, last_message, last_message_at, unread_count)
       VALUES ($1, $2, $3, NOW(), 1)
       ON CONFLICT (phone) DO UPDATE SET
         display_name     = COALESCE(NULLIF(EXCLUDED.display_name, EXCLUDED.phone), conversations.display_name),
         last_message     = EXCLUDED.last_message,
         last_message_at  = NOW(),
         unread_count     = conversations.unread_count + 1
       RETURNING *`,
      [phone, displayName, text || `[${type}]`]
    );
    const conversation = convResult.rows[0];

    // Guardar mensaje entrante
    const msgResult = await query(
      `INSERT INTO messages
         (conversation_id, whatsapp_id, direction, sender_type, message_type, body, media_mime)
       VALUES ($1, $2, 'inbound', 'client', $3, $4, $5)
       ON CONFLICT (whatsapp_id) DO NOTHING
       RETURNING *`,
      [conversation.id, messageId, type, text || mediaCaption || null, mediaMime || null]
    );

    const message = msgResult.rows[0];
    if (!message) return; // duplicado

    // ¿Asesor en control? → emitir al panel y no responder
    if (conversation.status === 'human') {
      logger.info('👨‍💼 Modo humano activo, bot pausado', { phone });
      await emitSocketEvent('new_message', { conversation, message });
      return;
    }

    // Enrutar por tipo
    if (type === 'image' && mediaId) {
      await handleImageMessage({ conversation, message, phone, mediaId });
    } else if (type === 'text' && text) {
      await handleTextMessage({ conversation, message, phone, text });
    } else {
      await whatsapp.sendTextMessage(phone,
        `📸 Puedes enviarme texto o la foto de tu comprobante de pago.\n\nMétodos aceptados:\n${getPaymentBlock()}`
      );
    }

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
    // 1. Descargar imagen y actualizar mensaje
    const mediaInfo = await whatsapp.downloadMedia(mediaId);
    await query(
      `UPDATE messages SET media_url = $1, media_filename = $2, media_size = $3 WHERE id = $4`,
      [mediaInfo.url, mediaInfo.filename, mediaInfo.size, message.id]
    );

    // 2. Analizar con IA Vision (clasificar tipo + extraer datos de pago)
    let visionResult = null;
    if (process.env.OPENAI_API_KEY) {
      visionResult = await ai.analyzeVoucherWithAI(mediaInfo.path);
    }

    // 3. Clasificar tipo de imagen
    const imageType = visionResult?.image_type || 'comprobante_pago'; // sin IA → asumir pago
    logger.info('Imagen clasificada', { phone, imageType, confidence: visionResult?.confidence });

    // 3a. IMAGEN TÉCNICA (router, cables, luces) → soporte técnico con IA
    if (imageType === 'imagen_tecnica') {
      const historyResult = await query(
        `SELECT sender_type, body FROM messages
         WHERE conversation_id = $1 AND message_type = 'text' AND body IS NOT NULL
         ORDER BY created_at DESC LIMIT 5`,
        [conversation.id]
      );
      const history = historyResult.rows.reverse();
      let clientInfo = null;
      if (conversation.client_id) {
        const ccRes = await query('SELECT name FROM clients WHERE id = $1', [conversation.client_id]);
        if (ccRes.rows.length) clientInfo = { name: conversation.display_name || ccRes.rows[0].name };
      }
      const techDesc = visionResult?.tech_description || 'equipo de red';
      const aiResponse = await ai.generateConversationalResponse(
        `El cliente envió una foto de: ${techDesc}. Brinda soporte técnico según lo que se ve en la imagen.`,
        history, clientInfo
      );
      await whatsapp.sendTextMessage(phone, aiResponse.text);
      await saveOutboundMessage(conversation.id, aiResponse.text, 'bot');
      return;
    }

    // 3b. IMAGEN NO RELACIONADA (meme, selfie, etc.) → respuesta genérica
    if (imageType === 'otro' && visionResult?.confidence === 'high') {
      const response = `Solo puedo ayudarte con tu servicio de internet, pagos o soporte técnico. 😊\n\n¿Tienes algún problema con tu conexión o quieres registrar un pago?`;
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // 3c. COMPROBANTE DE PAGO (o imagen sin clasificar) → guardar + SIEMPRE pedir nombre
    const paymentId = await payment.savePendingVoucher({
      conversationId: conversation.id,
      messageId: message.id,
      imagePath: mediaInfo.path,
      aiVisionData: visionResult,
    });

    // SIEMPRE pedir nombre completo para registrar en WispHub
    await query(`UPDATE conversations SET bot_intent = 'awaiting_payment_name' WHERE id = $1`, [conversation.id]);
    const askMsg = `Gracias por enviar tu comprobante. 🙌\n\nPara registrar tu pago, indícame por favor el *nombre completo* del titular del servicio.`;
    await whatsapp.sendTextMessage(phone, askMsg);
    await saveOutboundMessage(conversation.id, askMsg, 'bot');

  } catch (err) {
    logger.error('❌ Error procesando imagen', { phone, error: err.message });
    const errorMsg = 'Ocurrió un problema con tu comprobante. Nuestro equipo lo revisará pronto. También puedes contactar soporte: *932258382*';
    await whatsapp.sendTextMessage(phone, errorMsg).catch(() => {});
    await saveOutboundMessage(conversation.id, errorMsg, 'bot').catch(() => {});
    await escalateToHuman(conversation, 'Error procesando imagen').catch(() => {});
  }
};

// ─────────────────────────────────────────────────────────────
// MANEJAR NOMBRE ESCRITO POR EL CLIENTE
// Estados: 'awaiting_identity' | 'awaiting_payment_name'
// ─────────────────────────────────────────────────────────────

const handleNameInput = async ({ conversation, phone, text, mode }) => {
  try {
    // ¿Parece un nombre? (pocas palabras, sin signos de pregunta ni palabras clave de servicio)
    const looksLikeName = text.trim().split(/\s+/).length <= 6 &&
      !/[¿?]|pagar|internet|servicio|deuda|cuanto|ayuda|funciona|hola|buenos|buenas|gracias/i.test(text);

    if (!looksLikeName) {
      const response = `Para poder ayudarte, necesito tu *nombre completo* como titular del servicio. 😊\n\nPor ejemplo: _Juan Pérez García_`;
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    const providedName = text.trim();

    // Guardar nombre INMEDIATAMENTE como display_name (lo que el cliente escribió)
    await query(
      `UPDATE conversations SET display_name = $1, bot_intent = 'identity_ok' WHERE id = $2`,
      [providedName, conversation.id]
    );

    // Notificar al dashboard en tiempo real
    const { emitToAgents } = require('../config/socket');
    emitToAgents('conversation_update', { conversationId: conversation.id, display_name: providedName });

    logger.info('Nombre registrado', { phone, providedName, mode });

    // Buscar en WispHub POR NOMBRE para vincular cliente (deuda, plan, pagos)
    // NUNCA por teléfono — el nombre viene del cliente, no de WispHub
    let wispClient = null;
    try {
      wispClient = await wisphub.buscarClientePorNombre(providedName);
    } catch (e) {
      logger.warn('WispHub name search failed', { phone, error: e.message });
    }

    let clientInfo = { name: providedName };

    if (wispClient) {
      const clientId   = String(wispClient.id_servicio || wispClient.id);
      const clientName = wispClient.nombre || wispClient.name || providedName;
      const clientPlan = wispClient.plan || wispClient.nombre_plan || null;

      // Upsert cliente en caché local
      const clientRes = await query(
        `INSERT INTO clients (wisphub_id, phone, name, service_id, plan, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (wisphub_id) DO UPDATE
           SET phone=$2, name=$3, service_id=$4, plan=$5, last_synced_at=NOW()
         RETURNING id`,
        [clientId, phone, clientName, clientId, clientPlan]
      );

      // Vincular conversación al cliente WispHub
      await query(
        `UPDATE conversations SET client_id = $1 WHERE id = $2`,
        [clientRes.rows[0].id, conversation.id]
      );
      // Actualizar conversation en memoria para el resto del flujo
      conversation.client_id = clientRes.rows[0].id;

      clientInfo = { name: providedName, plan: clientPlan, wisphub_id: clientId };

      // Obtener deuda real
      try {
        const debtInfo = await wisphub.consultarDeuda(clientId);
        clientInfo.debt_amount = debtInfo.monto_deuda;
        clientInfo.tiene_deuda = debtInfo.tiene_deuda;
      } catch {}

      logger.info('Cliente vinculado a WispHub', { phone, wispName: clientName, wisphub_id: clientId });
    } else {
      logger.info('Nombre no encontrado en WispHub, continuando sin vincular', { phone, providedName });
    }

    // ── MODO PAGO ──────────────────────────────────────────────────
    if (mode === 'payment') {
      if (!wispClient) {
        // No está en WispHub → escalar para revisión manual
        const response = `No encontré una cuenta registrada con el nombre *${providedName}* en nuestro sistema.\n\nUn *asesor* revisará tu comprobante manualmente. 👨‍💼`;
        await whatsapp.sendTextMessage(phone, response);
        await saveOutboundMessage(conversation.id, response, 'bot');
        await escalateToHuman(conversation, `"${providedName}" no encontrado en WispHub para pago`);
        return;
      }

      // Buscar pago pendiente y procesarlo
      const pending = await query(
        `SELECT id FROM payments WHERE conversation_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        [conversation.id]
      );

      if (pending.rows.length) {
        await processPendingPayment(conversation, phone, pending.rows[0].id);
      } else {
        const welcome = `¡Gracias, *${providedName}*! ✅ No encontré un comprobante pendiente. Si ya lo enviaste, nuestro equipo lo revisará pronto.`;
        await whatsapp.sendTextMessage(phone, welcome);
        await saveOutboundMessage(conversation.id, welcome, 'bot');
      }
      return;
    }

    // ── MODO CHAT ──────────────────────────────────────────────────
    const debtMsg = clientInfo.tiene_deuda && clientInfo.debt_amount > 0
      ? ` Tienes un saldo pendiente de *S/ ${clientInfo.debt_amount}*.`
      : '';
    const welcome = `¡Hola, *${providedName}*! 😊${debtMsg} ¿En qué puedo ayudarte hoy?`;
    await whatsapp.sendTextMessage(phone, welcome);
    await saveOutboundMessage(conversation.id, welcome, 'bot');

  } catch (err) {
    logger.error('Error en handleNameInput', { phone, error: err.message });
    const response = '😔 No pude procesar tu solicitud. Por favor contacta soporte: *932258382*';
    await whatsapp.sendTextMessage(phone, response).catch(() => {});
    await saveOutboundMessage(conversation.id, response, 'bot').catch(() => {});
  }
};

// ─────────────────────────────────────────────────────────────
// PROCESAR PAGO PENDIENTE (helper compartido)
// ─────────────────────────────────────────────────────────────

const processPendingPayment = async (conversation, phone, paymentId) => {
  // Obtener el wisphub_id del cliente confirmado para evitar búsqueda por teléfono incorrecta
  let wisphubClientId = null;
  if (conversation.client_id) {
    try {
      const ccRes = await query('SELECT wisphub_id FROM clients WHERE id = $1', [conversation.client_id]);
      wisphubClientId = ccRes.rows[0]?.wisphub_id || null;
      if (wisphubClientId) logger.info('Usando wisphub_id confirmado para pago', { wisphubClientId });
    } catch {}
  }

  const result = await payment.finalizePendingVoucher(paymentId, phone, wisphubClientId);
  const responseText = buildPaymentResponse(result);
  await whatsapp.sendTextMessage(phone, responseText);
  await saveOutboundMessage(conversation.id, responseText, 'bot');

  if (['manual_review', 'error', 'client_not_found'].includes(result.status)) {
    await escalateToHuman(conversation, `Pago requiere revisión: ${result.status}`);
  }
  await logEvent(conversation.id, paymentId, 'payment_processed', result.status);
  await emitSocketEvent('payment_update', { conversationId: conversation.id, status: result.status });
};

// ─────────────────────────────────────────────────────────────
// MANEJAR TEXTO (chatbot con IA)
// ─────────────────────────────────────────────────────────────

const handleTextMessage = async ({ conversation, message, phone, text }) => {
  try {
    // 1. ¿Esperando nombre del cliente?
    if (conversation.bot_intent === 'awaiting_identity') {
      await handleNameInput({ conversation, phone, text, mode: 'chat' });
      return;
    }
    if (conversation.bot_intent === 'awaiting_payment_name') {
      await handleNameInput({ conversation, phone, text, mode: 'payment' });
      return;
    }

    // 2. Historial para IA
    const historyResult = await query(
      `SELECT sender_type, body FROM messages
       WHERE conversation_id = $1 AND message_type = 'text' AND body IS NOT NULL
       ORDER BY created_at DESC LIMIT 15`,
      [conversation.id]
    );
    const history = historyResult.rows.reverse();

    // 3. ¿El cliente ya proporcionó su nombre?
    //    client_id → WispHub vinculado | bot_intent = 'identity_ok' → nombre guardado sin WispHub
    const hasIdentity = !!(conversation.client_id || conversation.bot_intent === 'identity_ok');

    if (!hasIdentity) {
      // Pedir nombre siempre — nunca auto-identificar por teléfono
      await query(`UPDATE conversations SET bot_intent = 'awaiting_identity' WHERE id = $1`, [conversation.id]);
      const response = `Hola, bienvenido a *Fiber Perú*. 😊\n\nPara poder ayudarte, ¿me indicas tu *nombre completo* del titular del servicio?`;
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // 4. Obtener clientInfo del cliente confirmado (de la BD, no de WispHub por teléfono)
    // Detectar si display_name es un username de sistema (sin espacios + tiene dígitos) → no usarlo
    const rawDisplayName = conversation.display_name || '';
    const isRealName = rawDisplayName &&
      rawDisplayName !== conversation.phone &&
      rawDisplayName.trim().length > 2 &&
      (rawDisplayName.includes(' ') || /^[A-Za-zÀ-ÿ\s]+$/.test(rawDisplayName));

    let clientInfo = { name: isRealName ? rawDisplayName : 'Cliente' };

    if (conversation.client_id) {
      try {
        const ccRes = await query(
          'SELECT name, plan, wisphub_id FROM clients WHERE id = $1',
          [conversation.client_id]
        );
        if (ccRes.rows.length) {
          const cc = ccRes.rows[0];
          // Preferir display_name real; si es username, usar nombre de BD con misma validación
          const ccNameIsReal = cc.name && cc.name.includes(' ');
          const bestName = isRealName ? rawDisplayName : (ccNameIsReal ? cc.name : 'Cliente');
          clientInfo = { name: bestName, plan: cc.plan, wisphub_id: cc.wisphub_id };
          if (cc.wisphub_id) {
            try {
              const debtInfo = await wisphub.consultarDeuda(cc.wisphub_id);
              clientInfo.debt_amount = debtInfo.monto_deuda;
              clientInfo.tiene_deuda = debtInfo.tiene_deuda;
            } catch {}
          }
        }
      } catch (e) {
        logger.warn('No se pudo obtener clientInfo', { error: e.message });
      }
    }

    // 5. ¿Quiere hablar con humano?
    const quiereHumano = /asesor|agente|humano|persona|hablar con alguien|no entiendo/i.test(text);
    if (quiereHumano) {
      await escalateToHuman(conversation, 'Cliente solicitó asesor humano');
      const response = '👨‍💼 Te voy a conectar con un asesor humano ahora mismo. Un momento por favor...';
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // 6. Detectar intención
    const intent = await ai.detectIntent(text, history);

    // 7. Auto-escalar reclamos
    if (intent.intent === 'complaint' && intent.confidence > 0.6) {
      await escalateToHuman(conversation, 'Reclamo detectado automáticamente');
      const response = '😔 Lamento los inconvenientes. Un *asesor humano* revisará tu caso de inmediato. Por favor espera. ⏳';
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // 8. Respuesta con IA conversacional
    const aiResponse = await ai.generateConversationalResponse(text, history, clientInfo);
    await whatsapp.sendTextMessage(phone, aiResponse.text);
    await saveOutboundMessage(conversation.id, aiResponse.text, 'bot');

    await query(
      `UPDATE conversations SET
         bot_intent = 'identity_ok',
         last_message = $1,
         last_message_at = NOW()
       WHERE id = $2`,
      [aiResponse.text.substring(0, 100), conversation.id]
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
  const aiData = result.aiVisionData || result.ocrResult || {};
  const debt   = result.debtInfo || {};

  switch (result.status) {
    case 'success':
      return `✅ *Pago registrado exitosamente*\n\n💰 Monto: S/ ${aiData.amount}\n📅 Fecha: ${aiData.paymentDate || 'hoy'}\n🔢 Operación: ${aiData.operationCode || 'N/A'}\n\nTu servicio ha sido actualizado. ¡Gracias por pagar con Fiber Perú! 🎉`;

    case 'duplicate':
      return `⚠️ *Comprobante ya registrado*\n\nEste comprobante ya fue procesado anteriormente.\n\nSi crees que es un error, comunícate con soporte: *932258382*`;

    case 'unreadable':
      return `📸 La imagen no está clara. Por favor toma la foto con buena iluminación y que se vea el monto y el número de operación.\n\nIntenta de nuevo. 🔄`;

    case 'client_not_found':
      return `No encontramos tu número registrado como cliente de Fiber Perú.\n\nSi ya tienes contrato: *932258382*\nSi deseas contratar: *940366709* 😊`;

    case 'amount_mismatch':
      return `⚠️ El monto del comprobante (*S/ ${aiData.amount || 'N/A'}*) no coincide con tu deuda pendiente (*S/ ${debt.monto_deuda || 'N/A'}*).\n\nUn asesor revisará tu caso: *932258382*`;

    case 'no_debt':
      return `✅ Tu cuenta está al día, no tienes deuda pendiente en este momento.\n\n¿Tienes otra consulta? *932258382* 😊`;

    case 'manual_review':
      return `Hemos recibido tu comprobante. Nuestro equipo lo validará en breve y te confirmaremos. ✅\n\n¿Consultas? *932258382*`;

    default:
      return `Ocurrió un problema con tu comprobante. Por favor comunícate con soporte: *932258382* 👨‍💼`;
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

const saveOutboundMessage = async (conversationId, body, senderType) => {
  const result = await query(
    `INSERT INTO messages (conversation_id, direction, sender_type, message_type, body)
     VALUES ($1, 'outbound', $2, 'text', $3)
     RETURNING *`,
    [conversationId, senderType, body]
  );
  const msg = result.rows[0];
  if (msg) {
    const convRes = await query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
    const conversation = convRes.rows[0] || { id: conversationId };
    await emitSocketEvent('new_message', { conversation, message: msg });
  }
  return result;
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
    if (event === 'new_message' && data.message?.conversation_id) {
      emitToConversation(data.message.conversation_id, 'message', data.message);
    }
  } catch {
    // Socket no crítico
  }
};

module.exports = { verify, receive };
