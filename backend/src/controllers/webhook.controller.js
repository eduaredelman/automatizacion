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
    const voucherUrl = '/uploads/' + require('path').basename(mediaInfo.path);
    await query(
      `UPDATE messages SET media_url = $1, media_filename = $2, media_size = $3 WHERE id = $4`,
      [mediaInfo.url, mediaInfo.filename, mediaInfo.size, message.id]
    );

    // 2. Analizar con IA Vision
    let visionResult = null;
    if (process.env.OPENAI_API_KEY) {
      visionResult = await ai.analyzeVoucherWithAI(mediaInfo.path);
    }

    // 3. Rechazar si claramente no es un comprobante (alta confianza)
    if (visionResult && !visionResult.is_valid_voucher && visionResult.confidence === 'high') {
      const response = `❓ La imagen que enviaste no parece ser un comprobante de pago.\n\nPor favor envía la captura de tu pago realizado por:\n${getPaymentBlock()}\n\n¿Tienes dudas? Responde este mensaje. 😊`;
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // 4. Guardar registro de pago pendiente (sin procesar aún)
    const paymentId = await payment.savePendingVoucher({
      conversationId: conversation.id,
      messageId: message.id,
      imagePath: mediaInfo.path,
      aiVisionData: visionResult,
    });

    // 5. Verificar si identidad ya fue confirmada en esta conversación
    const identityConfirmed = !!conversation.client_id;

    if (!identityConfirmed) {
      // Buscar por teléfono para mostrar el nombre registrado
      const wispClient = await wisphub.buscarClientePorTelefono(phone);
      const wispName = wispClient?.nombre || wispClient?.name || null;

      if (wispName) {
        // Mostrar nombre y pedir confirmación (Sí/No)
        await query(
          `UPDATE conversations SET bot_intent = 'awaiting_payment_confirmation' WHERE id = $1`,
          [conversation.id]
        );
        const askMsg = `Hemos recibido tu comprobante. ✅\n\nAntes de registrarlo, encontré este número a nombre de *${wispName}*.\n\n¿Eres tú? Responde *Sí* o *No*.`;
        await whatsapp.sendTextMessage(phone, askMsg);
        await saveOutboundMessage(conversation.id, askMsg, 'bot');
      } else {
        // Nombre nulo en WispHub o no encontrado, pedir nombre
        await query(
          `UPDATE conversations SET bot_intent = 'awaiting_payment_name' WHERE id = $1`,
          [conversation.id]
        );
        const askMsg = `Hemos recibido tu comprobante. ✅\n\nPara registrar tu pago correctamente, ¿me confirmas tu *nombre completo* tal como está registrado en Fiber Perú?`;
        await whatsapp.sendTextMessage(phone, askMsg);
        await saveOutboundMessage(conversation.id, askMsg, 'bot');
      }
      return;
    }

    // 6. Identidad confirmada → finalizar pago
    const result = await payment.finalizePendingVoucher(paymentId, phone);
    const responseText = buildPaymentResponse(result);
    await whatsapp.sendTextMessage(phone, responseText);
    await saveOutboundMessage(conversation.id, responseText, 'bot');

    if (['manual_review', 'error', 'client_not_found'].includes(result.status)) {
      await escalateToHuman(conversation, `Pago requiere revisión: ${result.status}`);
    }

    await logEvent(conversation.id, paymentId, 'payment_processed', result.status);
    await emitSocketEvent('payment_update', { conversationId: conversation.id, status: result.status });

  } catch (err) {
    logger.error('❌ Error procesando imagen', { phone, error: err.message });
    const errorMsg = 'Ocurrió un problema con tu comprobante. Nuestro equipo lo revisará pronto. También puedes contactar soporte: *932258382*';
    await whatsapp.sendTextMessage(phone, errorMsg).catch(() => {});
    await saveOutboundMessage(conversation.id, errorMsg, 'bot').catch(() => {});
    await escalateToHuman(conversation, 'Error procesando imagen').catch(() => {});
  }
};

// ─────────────────────────────────────────────────────────────
// CONFIRMAR IDENTIDAD POR SÍ/NO
// Se llama cuando bot mostró el nombre registrado y espera confirmación
// Estados: 'awaiting_confirmation' | 'awaiting_payment_confirmation'
// ─────────────────────────────────────────────────────────────

const handleYesNoConfirmation = async ({ conversation, phone, text, mode }) => {
  try {
    const normalized = (text || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const isYes = /^(si|yes|ok|claro|correcto|exacto|asi es|soy yo|confirmo|afirmo|cierto|verdad|efectivo|dale|va|de acuerdo|por supuesto|obvio|desde luego|en efecto|aha|yep|yap|afirmativo|afirmati)/.test(normalized);
    const isNo  = /^(no|nop|nel|para nada|no soy|no es|negativo|incorrecto|error|equivocado)/.test(normalized);

    if (isYes) {
      // Re-lookup WispHub por teléfono (mismo número, mismo resultado)
      const wispClient = await wisphub.buscarClientePorTelefono(phone);
      if (!wispClient) {
        logger.warn('WispHub client not found on confirmation re-lookup', { phone });
        const response = `Hubo un problema verificando tu información. Por favor espera, un asesor te atenderá. 👨‍💼`;
        await whatsapp.sendTextMessage(phone, response);
        await saveOutboundMessage(conversation.id, response, 'bot');
        await escalateToHuman(conversation, 'Cliente no encontrado en WispHub en re-lookup de confirmación');
        return;
      }
      await confirmClientIdentity(conversation, phone, wispClient, mode);

    } else if (isNo) {
      // Dijeron No → pedir nombre y dirección para buscar diferente
      const nextIntent = mode === 'payment' ? 'awaiting_payment_name' : 'awaiting_identity';
      await query(`UPDATE conversations SET bot_intent = $1 WHERE id = $2`, [nextIntent, conversation.id]);
      const response = `Entendido. Para encontrar tu cuenta correctamente, ¿me indicas tu *nombre completo* y tu *dirección o referencia* de instalación?`;
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');

    } else {
      // Respuesta que no es Sí/No (ej: "Quiero pagar", "Tengo problemas")
      // → Responder con IA a lo que preguntó + recordar confirmar identidad
      logger.info('Respuesta fuera de Sí/No en confirmación, delegando a IA', { phone, text });

      const historyResult = await query(
        `SELECT sender_type, body FROM messages
         WHERE conversation_id = $1 AND message_type = 'text' AND body IS NOT NULL
         ORDER BY created_at DESC LIMIT 8`,
        [conversation.id]
      );
      const history = historyResult.rows.reverse();

      const aiResponse = await ai.generateConversationalResponse(text, history, null);
      const reminder = `\n\n_(Para acceder a tu cuenta, aún necesito que confirmes si eres la persona registrada. Responde *Sí* o *No*.)_`;
      const fullResponse = aiResponse.text + reminder;

      await whatsapp.sendTextMessage(phone, fullResponse);
      await saveOutboundMessage(conversation.id, fullResponse, 'bot');
    }

  } catch (err) {
    logger.error('Error en handleYesNoConfirmation', { phone, error: err.message });
    const response = '😔 No pude procesar tu respuesta. Por favor intenta de nuevo o contacta soporte: *932258382*';
    await whatsapp.sendTextMessage(phone, response).catch(() => {});
    await saveOutboundMessage(conversation.id, response, 'bot').catch(() => {});
  }
};

// ─────────────────────────────────────────────────────────────
// CONFIRMAR IDENTIDAD POR NOMBRE ESCRITO
// Se llama cuando bot pidió nombre completo y cliente lo envió
// Estados: 'awaiting_identity' | 'awaiting_payment_name'
// ─────────────────────────────────────────────────────────────

const handleNameInput = async ({ conversation, phone, text, mode }) => {
  try {
    // 1. Intentar buscar por nombre en WispHub
    let wispClient = await wisphub.buscarClientePorNombre(text);

    // 2. Si no encontró por nombre, SIEMPRE intentar por teléfono como fallback
    //    Esto rompe el loop: si el cliente está en el sistema, lo confirmamos sin importar qué escribió
    if (!wispClient) {
      logger.info('Nombre no encontrado, buscando por teléfono como fallback', { phone, text });
      wispClient = await wisphub.buscarClientePorTelefono(phone);
    }

    if (wispClient) {
      logger.info('Cliente encontrado, confirmando identidad', { phone, name: wispClient.nombre });
      await confirmClientIdentity(conversation, phone, wispClient, mode);
      return;
    }

    // 3. Realmente no está en el sistema: responder con IA a lo que dijo + escalar
    logger.info('Cliente no encontrado en WispHub, escalando a humano', { phone });

    const historyResult = await query(
      `SELECT sender_type, body FROM messages
       WHERE conversation_id = $1 AND message_type = 'text' AND body IS NOT NULL
       ORDER BY created_at DESC LIMIT 8`,
      [conversation.id]
    );
    const history = historyResult.rows.reverse();

    // Si parece una pregunta/solicitud (no un nombre), responder con IA primero
    const pareceNombre = text.trim().split(/\s+/).length <= 5 && !/[¿?]|pagar|internet|servicio|deuda|cuanto|ayuda|funciona/i.test(text);

    if (!pareceNombre) {
      // Responder a lo que preguntó con IA, luego escalar
      const aiResponse = await ai.generateConversationalResponse(text, history, null);
      await whatsapp.sendTextMessage(phone, aiResponse.text);
      await saveOutboundMessage(conversation.id, aiResponse.text, 'bot');
    }

    const escalarMsg = `Un *asesor humano* te atenderá en breve para ayudarte con tu cuenta. Por favor espera. 👨‍💼`;
    await whatsapp.sendTextMessage(phone, escalarMsg);
    await saveOutboundMessage(conversation.id, escalarMsg, 'bot');
    await escalateToHuman(conversation, `Cliente no encontrado por nombre o teléfono: "${text}"`);

  } catch (err) {
    logger.error('Error en handleNameInput', { phone, error: err.message });
    const response = '😔 No pude verificar tu identidad en este momento. Te conectamos con un asesor.';
    await whatsapp.sendTextMessage(phone, response).catch(() => {});
    await saveOutboundMessage(conversation.id, response, 'bot').catch(() => {});
    await escalateToHuman(conversation, 'Error verificando identidad por nombre').catch(() => {});
  }
};

// ─────────────────────────────────────────────────────────────
// CONFIRMAR IDENTIDAD (lógica compartida)
// Guarda cliente en BD, vincula conversación, procesa pago si aplica
// ─────────────────────────────────────────────────────────────

const confirmClientIdentity = async (conversation, phone, wispClient, mode) => {
  const clientId   = String(wispClient.id_servicio || wispClient.id);
  const clientName = wispClient.nombre || wispClient.name || 'Cliente';
  const clientPlan = wispClient.plan || wispClient.nombre_plan || null;

  // Upsert en caché local
  const clientRes = await query(
    `INSERT INTO clients (wisphub_id, phone, name, service_id, plan, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (wisphub_id) DO UPDATE
       SET phone=$2, name=$3, service_id=$4, plan=$5, last_synced_at=NOW()
     RETURNING id`,
    [clientId, phone, clientName, clientId, clientPlan]
  );

  // Vincular conversación al cliente y marcar identidad confirmada
  await query(
    `UPDATE conversations SET client_id = $1, display_name = $2, bot_intent = 'identity_ok' WHERE id = $3`,
    [clientRes.rows[0].id, clientName, conversation.id]
  );

  // Obtener deuda
  let clientInfo = { name: clientName, plan: clientPlan, wisphub_id: clientId, debt_amount: null, tiene_deuda: false };
  try {
    const debtInfo = await wisphub.consultarDeuda(clientId);
    clientInfo.debt_amount = debtInfo.monto_deuda;
    clientInfo.tiene_deuda = debtInfo.tiene_deuda;
  } catch (e) { /* deuda opcional */ }

  logger.info('Identidad confirmada ✅', { phone, name: clientName, clientId });

  if (mode === 'payment') {
    // Buscar el pago pendiente más reciente de esta conversación
    const pending = await query(
      `SELECT id FROM payments WHERE conversation_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [conversation.id]
    );

    if (pending.rows.length) {
      const result = await payment.finalizePendingVoucher(pending.rows[0].id, phone);
      const responseText = buildPaymentResponse(result);
      await whatsapp.sendTextMessage(phone, responseText);
      await saveOutboundMessage(conversation.id, responseText, 'bot');

      if (['manual_review', 'error', 'client_not_found'].includes(result.status)) {
        await escalateToHuman({ id: conversation.id }, `Pago requiere revisión: ${result.status}`);
      }
      await logEvent(conversation.id, pending.rows[0].id, 'payment_processed', result.status);
      await emitSocketEvent('payment_update', { conversationId: conversation.id, status: result.status });
    } else {
      const welcome = `¡Gracias, ${clientName}! ✅ No encontré un comprobante pendiente. Si ya lo enviaste, nuestro equipo lo revisará pronto.`;
      await whatsapp.sendTextMessage(phone, welcome);
      await saveOutboundMessage(conversation.id, welcome, 'bot');
    }

  } else {
    // Solo confirmación de identidad → bienvenida con contexto
    const debtMsg = clientInfo.tiene_deuda && clientInfo.debt_amount > 0
      ? ` Tienes un saldo pendiente de *S/ ${clientInfo.debt_amount}*.`
      : '';
    const welcome = `¡Perfecto, ${clientName}! 😊${debtMsg} ¿En qué puedo ayudarte hoy?`;
    await whatsapp.sendTextMessage(phone, welcome);
    await saveOutboundMessage(conversation.id, welcome, 'bot');
  }
};

// ─────────────────────────────────────────────────────────────
// MANEJAR TEXTO (chatbot con IA)
// ─────────────────────────────────────────────────────────────

const handleTextMessage = async ({ conversation, message, phone, text }) => {
  try {
    // 1. ¿Estamos esperando respuesta Sí/No de confirmación de identidad?
    if (conversation.bot_intent === 'awaiting_confirmation') {
      await handleYesNoConfirmation({ conversation, phone, text, mode: 'chat' });
      return;
    }
    if (conversation.bot_intent === 'awaiting_payment_confirmation') {
      await handleYesNoConfirmation({ conversation, phone, text, mode: 'payment' });
      return;
    }

    // 2. ¿Estamos esperando nombre escrito del cliente?
    if (conversation.bot_intent === 'awaiting_identity') {
      await handleNameInput({ conversation, phone, text, mode: 'chat' });
      return;
    }
    if (conversation.bot_intent === 'awaiting_payment_name') {
      await handleNameInput({ conversation, phone, text, mode: 'payment' });
      return;
    }

    // 3. Historial para contexto de IA
    const historyResult = await query(
      `SELECT sender_type, body FROM messages
       WHERE conversation_id = $1 AND message_type = 'text' AND body IS NOT NULL
       ORDER BY created_at DESC LIMIT 15`,
      [conversation.id]
    );
    const history = historyResult.rows.reverse();

    // 4. SIEMPRE consultar WispHub como fuente principal
    let clientInfo = null;
    let wispClient = null;

    try {
      wispClient = await wisphub.buscarClientePorTelefono(phone);

      if (wispClient) {
        const clientId   = String(wispClient.id_servicio || wispClient.id);
        const clientName = wispClient.nombre || wispClient.name || null;
        const clientPlan = wispClient.plan || wispClient.nombre_plan || null;

        logger.info('WispHub cliente encontrado', { phone, name: clientName, clientId });

        // Actualizar caché local (no bloqueante)
        query(
          `INSERT INTO clients (wisphub_id, phone, name, service_id, plan, last_synced_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (wisphub_id) DO UPDATE
             SET phone=$2, name=$3, service_id=$4, plan=$5, last_synced_at=NOW()`,
          [clientId, phone, clientName || 'N/A', clientId, clientPlan]
        ).catch(e => logger.warn('Cache update failed', { error: e.message }));

        clientInfo = { name: clientName, plan: clientPlan, debt_amount: null, wisphub_id: clientId };

        // Obtener deuda en tiempo real
        try {
          const debtInfo = await wisphub.consultarDeuda(clientId);
          clientInfo.debt_amount = debtInfo.monto_deuda;
          clientInfo.tiene_deuda = debtInfo.tiene_deuda;
          logger.info('WispHub deuda resultado', { phone, tiene_deuda: debtInfo.tiene_deuda, monto: debtInfo.monto_deuda });
        } catch (debtErr) {
          logger.warn('No se pudo consultar deuda', { phone, error: debtErr.message });
        }

      } else {
        // No registrado en WispHub
        logger.info('Número no registrado en WispHub', { phone });

        if (!conversation.client_id) {
          // Primer contacto: pedir nombre y dirección para buscar manualmente
          await query(`UPDATE conversations SET bot_intent = 'awaiting_identity' WHERE id = $1`, [conversation.id]);
          const response = `Hola, gracias por contactarte con *Fiber Perú*. 😊\n\nTu número no figura en nuestro sistema. Para poder ayudarte, ¿me indicas tu *nombre completo* y *dirección o referencia* de instalación?`;
          await whatsapp.sendTextMessage(phone, response);
          await saveOutboundMessage(conversation.id, response, 'bot');
          return;
        }
        // Si ya estaba confirmado antes, seguir con IA
      }
    } catch (wispErr) {
      logger.warn('WispHub no disponible, usando caché local', { phone, error: wispErr.message });
      // Fallback a BD local
      const local = await query(
        `SELECT cl.name, cl.plan, cl.debt_amount, cl.wisphub_id
         FROM clients cl JOIN conversations c ON c.phone = cl.phone WHERE c.id = $1`,
        [conversation.id]
      );
      if (local.rows.length) {
        clientInfo = local.rows[0];
        logger.info('Usando datos de caché local', { phone });
      }
    }

    // 5. ¿Identidad confirmada? (conversation.client_id existe)
    const identityConfirmed = !!conversation.client_id;

    if (wispClient && !identityConfirmed) {
      // Cliente existe en WispHub pero aún no confirmó identidad
      const wispName = wispClient.nombre || wispClient.name || null;

      if (wispName) {
        // Mostrar nombre y pedir Sí/No
        if (clientInfo?.name && clientInfo.name !== 'N/A') {
          query(`UPDATE conversations SET display_name = $1 WHERE id = $2`, [clientInfo.name, conversation.id]).catch(() => {});
        }
        await query(`UPDATE conversations SET bot_intent = 'awaiting_confirmation' WHERE id = $1`, [conversation.id]);
        const response = `Hola, soy el asistente de *Fiber Perú*. 😊\n\nEncontré tu número registrado a nombre de *${wispName}*.\n\n¿Eres tú? Responde *Sí* o *No*.`;
        await whatsapp.sendTextMessage(phone, response);
        await saveOutboundMessage(conversation.id, response, 'bot');
      } else {
        // Nombre nulo en WispHub → pedir nombre
        await query(`UPDATE conversations SET bot_intent = 'awaiting_identity' WHERE id = $1`, [conversation.id]);
        const response = `Hola, soy el asistente de *Fiber Perú*. 😊\n\nPara brindarte el mejor servicio, ¿me confirmas tu *nombre completo* como aparece en tu contrato?`;
        await whatsapp.sendTextMessage(phone, response);
        await saveOutboundMessage(conversation.id, response, 'bot');
      }
      return;
    }

    // 6. Pide hablar con humano
    const quiereHumano = /asesor|agente|humano|persona|hablar con alguien|no entiendo/i.test(text);
    if (quiereHumano) {
      await escalateToHuman(conversation, 'Cliente solicitó asesor humano');
      const response = '👨‍💼 Te voy a conectar con un asesor humano ahora mismo. Un momento por favor...';
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // 7. Detectar intención
    const intent = await ai.detectIntent(text, history);

    // 8. Auto-escalar reclamos
    if (intent.intent === 'complaint' && intent.confidence > 0.6) {
      await escalateToHuman(conversation, 'Reclamo detectado automáticamente');
      const response = '😔 Lamento los inconvenientes. Un *asesor humano* revisará tu caso de inmediato. Por favor espera un momento. ⏳';
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // 9. Generar respuesta con IA conversacional
    const aiResponse = await ai.generateConversationalResponse(text, history, clientInfo);
    await whatsapp.sendTextMessage(phone, aiResponse.text);
    await saveOutboundMessage(conversation.id, aiResponse.text, 'bot');

    // 10. Actualizar intención (preservar identity_ok si ya estaba confirmado)
    await query(
      `UPDATE conversations SET
         bot_intent = CASE WHEN client_id IS NOT NULL THEN 'identity_ok' ELSE $1 END,
         last_message = $2,
         last_message_at = NOW()
       WHERE id = $3`,
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
