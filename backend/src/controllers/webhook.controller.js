const { query } = require('../config/database');
const whatsapp = require('../services/whatsapp.service');
const ai = require('../services/ai.service');
const payment = require('../services/payment.service');
const wisphub = require('../services/wisphub.service');
const logger = require('../utils/logger');
const { getPaymentBlock } = require('../config/payment-info');

// ─────────────────────────────────────────────────────────────
// HORARIO DE ATENCIÓN (Lun–Sáb, 8:00 AM – 6:00 PM Lima)
// ─────────────────────────────────────────────────────────────
const isWithinBusinessHours = () => {
  const limaTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const hour = limaTime.getHours(); // 0-23
  const day  = limaTime.getDay();   // 0=Dom, 6=Sáb
  return hour >= 8 && hour < 18 && day >= 1 && day <= 6;
};

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

    const { phone, displayName, messageId, type: rawType, text, mediaId, mediaMime, mediaCaption, mediaFilename } = parsed;
    // Normalizar 'voice' → 'audio' para coincidir con el CHECK constraint de la BD
    const type = rawType === 'voice' ? 'audio' : rawType;
    logger.info('📱 Mensaje entrante', { phone, type, messageId });

    await whatsapp.markAsRead(messageId).catch(() => {});

    // Upsert conversación
    // Si ya tiene client_id (WispHub vinculado), conservar su display_name de WispHub
    const convResult = await query(
      `INSERT INTO conversations (phone, display_name, last_message, last_message_at, unread_count)
       VALUES ($1, $2, $3, NOW(), 1)
       ON CONFLICT (phone) DO UPDATE SET
         display_name     = CASE
           WHEN conversations.client_id IS NOT NULL THEN conversations.display_name
           ELSE COALESCE(NULLIF(EXCLUDED.display_name, EXCLUDED.phone), conversations.display_name)
         END,
         last_message     = EXCLUDED.last_message,
         last_message_at  = NOW(),
         unread_count     = conversations.unread_count + 1,
         is_archived      = false
       RETURNING *`,
      [phone, displayName, text || `[${type}]`]
    );
    let conversation = convResult.rows[0];

    // ── AUTO-LINK: Si el teléfono ya está en la tabla clients (sync WispHub previo),
    // vincular la conversación INMEDIATAMENTE sin esperar que el cliente escriba su nombre.
    if (!conversation.client_id) {
      // Generar variantes del número para match robusto (con/sin prefijo 51, solo dígitos)
      const phoneDigits = phone.replace(/\D/g, '');
      const phoneVariants = [...new Set([
        phoneDigits,
        phoneDigits.startsWith('51') ? phoneDigits.slice(2) : phoneDigits,
        phoneDigits.startsWith('51') ? phoneDigits : `51${phoneDigits}`,
      ])].filter(p => p.length >= 7);

      const clientLookup = await query(
        `SELECT id, name, wisphub_id, service_status, debt_amount, plan, plan_price FROM clients
         WHERE phone = ANY($1::text[]) AND phone != '' AND wisphub_id IS NOT NULL
         LIMIT 1`,
        [phoneVariants]
      ).catch(() => ({ rows: [] }));

      if (clientLookup.rows.length) {
        const found = clientLookup.rows[0];
        await query(
          `UPDATE conversations SET
             client_id    = $1,
             display_name = $2,
             bot_intent   = 'identity_ok'
           WHERE id = $3`,
          [found.id, found.name, conversation.id]
        );
        conversation = {
          ...conversation,
          client_id: found.id,
          display_name: found.name,
          bot_intent: 'identity_ok',
        };
        const { emitToAgents } = require('../config/socket');
        emitToAgents('conversation_update', {
          conversationId: conversation.id,
          display_name: found.name,
          client_id: found.id,
          bot_intent: 'identity_ok',
          client_service_status: found.service_status,
          client_debt: found.debt_amount,
          client_plan: found.plan,
          client_plan_price: found.plan_price,
        });
        logger.info('Auto-vinculado cliente WispHub por teléfono', { phone, name: found.name, wisphub_id: found.wisphub_id, service_status: found.service_status });
      }
    }

    // Guardar mensaje entrante (solo tipos válidos según el CHECK constraint)
    const validTypes = ['text','image','audio','video','document','location','sticker','reaction','system'];
    const msgType = validTypes.includes(type) ? type : 'text';
    const msgResult = await query(
      `INSERT INTO messages
         (conversation_id, whatsapp_id, direction, sender_type, message_type, body, media_mime, media_filename)
       VALUES ($1, $2, 'inbound', 'client', $3, $4, $5, $6)
       ON CONFLICT (whatsapp_id) DO NOTHING
       RETURNING *`,
      [conversation.id, messageId, msgType, text || mediaCaption || null, mediaMime || null, mediaFilename || null]
    );

    const message = msgResult.rows[0];

    // Descargar media para documentos y videos (independiente de modo bot/human)
    if (message && ['document', 'video'].includes(type) && mediaId) {
      whatsapp.downloadMedia(mediaId).then(mediaInfo => {
        query(
          `UPDATE messages SET media_url = $1, media_mime = $2, media_filename = $3, media_size = $4 WHERE id = $5`,
          [mediaInfo.url, mediaInfo.mime || mediaMime, mediaInfo.filename || mediaFilename, mediaInfo.size, message.id]
        ).then(() => {
          const { emitToAgents, emitToConversation } = require('../config/socket');
          const payload = {
            conversationId: conversation.id,
            messageId: message.id,
            media_url: mediaInfo.url,
            media_mime: mediaInfo.mime || mediaMime,
            media_filename: mediaInfo.filename || mediaFilename,
          };
          emitToAgents('message_media_ready', payload);
          emitToConversation(conversation.id, 'message_media_ready', payload);
        }).catch(() => {});
      }).catch(err => {
        logger.warn('Falló descarga de documento/video', { messageId: message.id, error: err.message });
      });
    }
    if (!message) return; // duplicado

    // ¿Conversación resuelta? → re-abrir como bot cuando el cliente escribe de nuevo
    if (conversation.status === 'resolved') {
      await query(`UPDATE conversations SET status = 'bot' WHERE id = $1`, [conversation.id]);
      conversation = { ...conversation, status: 'bot', wasResolved: true };
      const { emitToAgents } = require('../config/socket');
      emitToAgents('conversation_update', { conversationId: conversation.id, status: 'bot' });
      logger.info('🔄 Conversación resuelta reabierta automáticamente por nuevo mensaje', { phone });
    }

    // ¿Asesor en control? → emitir al panel y NO responder con el bot
    // IMPORTANTE: el estado 'human' solo pausa el auto-reply del bot.
    // Los mensajes SIEMPRE se guardan y se muestran en tiempo real al asesor.
    if (conversation.status === 'human') {
      logger.info('👨‍💼 Modo humano activo, bot pausado', { phone });

      // Descargar imagen/audio en background para que el asesor pueda verlos
      if (mediaId && (type === 'image' || type === 'audio') && message) {
        whatsapp.downloadMedia(mediaId).then(async (mediaInfo) => {
          await query(
            `UPDATE messages SET media_url = $1, media_mime = $2, media_filename = $3, media_size = $4 WHERE id = $5`,
            [mediaInfo.url, mediaInfo.mime || mediaMime, mediaInfo.filename || mediaFilename, mediaInfo.size || null, message.id]
          ).catch(() => {});
          const { emitToAgents, emitToConversation } = require('../config/socket');
          const payload = {
            conversationId: conversation.id,
            messageId: message.id,
            media_url: mediaInfo.url,
            media_mime: mediaInfo.mime || mediaMime,
            media_filename: mediaInfo.filename || mediaFilename,
          };
          emitToAgents('message_media_ready', payload);
          emitToConversation(conversation.id, 'message_media_ready', payload);
          logger.info('Media descargado en modo humano', { phone, type, url: mediaInfo.url });
        }).catch(err => logger.warn('Fallo descarga media en modo humano', { phone, type, error: err.message }));
      }

      await emitSocketEvent('new_message', { conversation, message });
      return;
    }

    // Enrutar por tipo
    if (type === 'image' && mediaId) {
      await handleImageMessage({ conversation, message, phone, mediaId });
    } else if (type === 'audio' && mediaId) {
      await handleAudioMessage({ conversation, message, phone, mediaId });
    } else if (type === 'text' && text) {
      await handleTextMessage({ conversation, message, phone, text });
    } else {
      await whatsapp.sendTextMessage(phone,
        `📸 Puedes enviarme texto, una foto de tu comprobante de pago o una nota de voz.\n\nMétodos aceptados:\n${getPaymentBlock()}`
      );
    }

    await emitSocketEvent('new_message', { conversation, message });

  } catch (err) {
    logger.error('❌ Error en webhook', { error: err.message, stack: err.stack });
  }
};

// ─────────────────────────────────────────────────────────────
// MANEJAR AUDIO (nota de voz → transcribir con Whisper → procesar como texto)
// ─────────────────────────────────────────────────────────────

const handleAudioMessage = async ({ conversation, message, phone, mediaId }) => {
  try {
    // 1. Descargar audio
    const mediaInfo = await whatsapp.downloadMedia(mediaId);
    await query(
      `UPDATE messages SET media_url = $1, media_mime = $2, media_filename = $3, media_size = $4 WHERE id = $5`,
      [mediaInfo.url, mediaInfo.mime || 'audio/ogg', mediaInfo.filename, mediaInfo.size, message.id]
    );

    // 2. Transcribir con OpenAI Whisper
    const transcript = await ai.transcribeAudio(mediaInfo.path).catch(() => null);

    // 3. Si hay transcripción → guardar en body y procesar como mensaje de texto
    if (transcript && transcript.trim().length > 0) {
      await query(`UPDATE messages SET body = $1 WHERE id = $2`, [transcript, message.id]);
      logger.info('Audio transcrito, procesando como texto', { phone, transcript: transcript.substring(0, 80) });
      await handleTextMessage({ conversation, message, phone, text: transcript });
    } else {
      // Sin transcripción → respuesta genérica pidiendo que escriba
      const response = `🎤 Recibí tu nota de voz, pero no pude transcribirla. ¿Puedes escribir tu consulta? 😊\n\nSi quieres registrar un pago, envíame la *foto de tu comprobante*.`;
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
    }
  } catch (err) {
    logger.error('❌ Error procesando audio', { phone, error: err.message });
    const response = '😔 No pude procesar tu nota de voz. Por favor escribe tu mensaje o llama a soporte: *932258382*';
    await whatsapp.sendTextMessage(phone, response).catch(() => {});
    await saveOutboundMessage(conversation.id, response, 'bot').catch(() => {});
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
         ORDER BY created_at DESC LIMIT 20`,
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

    // 3c. COMPROBANTE DE PAGO (o imagen sin clasificar) → guardar voucher
    const paymentId = await payment.savePendingVoucher({
      conversationId: conversation.id,
      messageId: message.id,
      imagePath: mediaInfo.path,
      aiVisionData: visionResult,
    });

    if (conversation.client_id) {
      // ✅ Cliente ya identificado via WispHub — procesar directamente sin pedir nombre
      const nombre = conversation.display_name && conversation.display_name !== phone
        ? conversation.display_name : 'Cliente';
      const ackMsg = `Gracias por tu comprobante, *${nombre}*. 🙌 Procesando tu pago...`;
      await whatsapp.sendTextMessage(phone, ackMsg);
      await saveOutboundMessage(conversation.id, ackMsg, 'bot');
      await processPendingPayment(conversation, phone, paymentId);
    } else {
      // ❓ Cliente desconocido — pedir nombre completo para vincular con WispHub
      await query(`UPDATE conversations SET bot_intent = 'awaiting_payment_name' WHERE id = $1`, [conversation.id]);
      const askMsg = `Gracias por enviar tu comprobante. 🙌\n\nPara registrar tu pago, indícame por favor el *nombre completo* del titular del servicio.`;
      await whatsapp.sendTextMessage(phone, askMsg);
      await saveOutboundMessage(conversation.id, askMsg, 'bot');
    }

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
    const { emitToAgents } = require('../config/socket');

    // Guardar nombre INMEDIATAMENTE como display_name (lo que el cliente escribió)
    // Luego se actualizará al nombre oficial de WispHub si se encuentra
    await query(
      `UPDATE conversations SET display_name = $1, bot_intent = 'identity_ok' WHERE id = $2`,
      [providedName, conversation.id]
    );
    emitToAgents('conversation_update', { conversationId: conversation.id, display_name: providedName, bot_intent: 'identity_ok' });

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

      // Extraer nombre del plan — WispHub puede usar varios campos
      const clientPlan = wispClient.plan || wispClient.nombre_plan || wispClient.plan_nombre ||
                         wispClient.servicio || wispClient.tipo_plan || null;

      // Extraer precio del plan directamente del objeto WispHub
      // (campo puede variar: precio_plan, monto_plan, costo, valor, precio_mensual, etc.)
      const planPrice  = parseFloat(
        wispClient.precio_plan || wispClient.monto_plan || wispClient.costo_plan ||
        wispClient.precio || wispClient.costo || wispClient.valor || wispClient.monto ||
        wispClient.precio_mensual || 0
      ) || null;

      // Log completo del objeto WispHub para diagnosticar campos disponibles
      logger.info('WispHub client object fields', {
        phone, clientId,
        campos: Object.keys(wispClient),
        plan: clientPlan,
        planPrice,
        rawPlan: {
          plan: wispClient.plan,
          nombre_plan: wispClient.nombre_plan,
          plan_nombre: wispClient.plan_nombre,
          precio_plan: wispClient.precio_plan,
          monto_plan: wispClient.monto_plan,
          costo: wispClient.costo,
          precio: wispClient.precio,
          valor: wispClient.valor,
          monto: wispClient.monto,
        },
      });

      // Upsert cliente en caché local
      const clientRes = await query(
        `INSERT INTO clients (wisphub_id, phone, name, service_id, plan, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (wisphub_id) DO UPDATE
           SET phone=$2, name=$3, service_id=$4, plan=$5, last_synced_at=NOW()
         RETURNING id`,
        [clientId, phone, clientName, clientId, clientPlan]
      );

      // Vincular conversación al cliente WispHub y actualizar display_name al nombre oficial
      await query(
        `UPDATE conversations SET client_id = $1, display_name = $2 WHERE id = $3`,
        [clientRes.rows[0].id, clientName, conversation.id]
      );
      conversation.client_id = clientRes.rows[0].id;

      // Emitir nombre oficial WispHub al frontend (puede diferir de lo que el cliente escribió)
      if (clientName !== providedName) {
        emitToAgents('conversation_update', {
          conversationId: conversation.id,
          display_name: clientName,
          client_id: clientRes.rows[0].id,
          bot_intent: 'identity_ok',
        });
      }

      clientInfo = { name: clientName, plan: clientPlan, wisphub_id: clientId };

      // Obtener deuda real — usuario de WispHub identifica las facturas del cliente
      try {
        const debtInfo = await wisphub.consultarDeuda(clientId, planPrice, wispClient.usuario || null);
        clientInfo.monto_mensual = debtInfo.monto_mensual || planPrice || null;
        clientInfo.tiene_deuda   = debtInfo.tiene_deuda;
      } catch {}

      logger.info('Cliente vinculado a WispHub', { phone, wispName: clientName, wisphub_id: clientId, plan: clientPlan, planPrice });
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
    let debtMsg = '';
    if (clientInfo.tiene_deuda && clientInfo.debt_amount > 0) {
      if (clientInfo.cantidad_facturas && clientInfo.monto_mensual) {
        debtMsg = `\n\n⚠️ Tienes *${clientInfo.cantidad_facturas} ${clientInfo.cantidad_facturas === 1 ? 'factura pendiente' : 'facturas pendientes'}* de *S/ ${clientInfo.monto_mensual}*/mes. Total a pagar: *S/ ${clientInfo.debt_amount}*.`;
      } else {
        debtMsg = `\n\n⚠️ Tienes un saldo pendiente de *S/ ${clientInfo.debt_amount}*.`;
      }
    }
    const welcome = `¡Hola, *${providedName}*! 😊${debtMsg}\n\n¿En qué puedo ayudarte hoy?`;
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
// AUTO-RESOLVER CONVERSACIÓN
// ─────────────────────────────────────────────────────────────

const RESOLVE_KEYWORDS = /^(gracias|grax|grac|ok|okey|oky|listo|listo!|solucionado|resuelto|perfecto|excelente|genial|entendido|de acuerdo|claro|ya|bueno|👍|✅|😊)[\s.!]*$/i;

const autoResolveConversation = async (conversationId, reason = 'auto') => {
  try {
    await query(
      `UPDATE conversations SET status = 'resolved', updated_at = NOW() WHERE id = $1 AND status != 'resolved'`,
      [conversationId]
    );
    await logEvent(conversationId, null, 'conversation_resolved', reason);
    await emitSocketEvent('conversation_updated', { conversationId, status: 'resolved' });
    logger.info('Conversación auto-resuelta', { conversationId, reason });
  } catch (err) {
    logger.warn('autoResolve error', { conversationId, error: err.message });
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

  if (['manual_review', 'error', 'client_not_found', 'old_debt_only'].includes(result.status)) {
    await escalateToHuman(conversation, `Pago requiere revisión: ${result.status}`);
  }
  await logEvent(conversation.id, paymentId, 'payment_processed', result.status);
  await emitSocketEvent('payment_update', { conversationId: conversation.id, status: result.status });

  // Auto-resolver cuando el pago fue exitoso
  if (['success', 'registered_no_debt'].includes(result.status)) {
    await autoResolveConversation(conversation.id, 'pago_exitoso');
  }
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

    // 2. Historial para IA (30 mensajes — incluye sesiones anteriores)
    const historyResult = await query(
      `SELECT sender_type, body FROM messages
       WHERE conversation_id = $1 AND message_type = 'text' AND body IS NOT NULL
       ORDER BY created_at DESC LIMIT 30`,
      [conversation.id]
    );
    const history = historyResult.rows.reverse();

    // 3. ¿El cliente ya proporcionó su nombre?
    //    Prioridad: client_id (WispHub) > bot_intent='identity_ok' > display_name real (fallback conv. antiguas)
    const rawDN = conversation.display_name || '';
    const displayNameIsReal = rawDN &&
      rawDN !== conversation.phone &&
      rawDN.trim().length > 2 &&
      /[A-Za-zÀ-ÿ]/.test(rawDN); // al menos una letra → no es solo número de teléfono

    const hasIdentity = !!(
      conversation.client_id ||
      conversation.bot_intent === 'identity_ok' ||
      // Fallback: display_name real guardado pero bot_intent quedó null (conversaciones antiguas / reinicio)
      (displayNameIsReal &&
        conversation.bot_intent !== 'awaiting_identity' &&
        conversation.bot_intent !== 'awaiting_payment_name')
    );

    if (!hasIdentity) {
      // Pedir nombre siempre — nunca auto-identificar por teléfono
      await query(`UPDATE conversations SET bot_intent = 'awaiting_identity' WHERE id = $1`, [conversation.id]);
      const response = `Hola, bienvenido a *Fiber Perú*. 😊\n\nPara poder ayudarte, ¿me indicas tu *nombre completo* del titular del servicio?`;
      await whatsapp.sendTextMessage(phone, response);
      await saveOutboundMessage(conversation.id, response, 'bot');
      return;
    }

    // Si era una conv. antigua con display_name real pero sin bot_intent → marcarla ahora
    if (displayNameIsReal && !conversation.client_id && conversation.bot_intent !== 'identity_ok') {
      await query(`UPDATE conversations SET bot_intent = 'identity_ok' WHERE id = $1`, [conversation.id]);
    }

    // 4. Obtener clientInfo del cliente confirmado (de la BD, no de WispHub por teléfono)
    // Detectar si display_name es un username de sistema (sin espacios + tiene dígitos) → no usarlo
    const rawDisplayName = conversation.display_name || '';
    const isRealName = rawDisplayName &&
      rawDisplayName !== conversation.phone &&
      rawDisplayName.trim().length > 2 &&
      (rawDisplayName.includes(' ') || /^[A-Za-zÀ-ÿ\s]+$/.test(rawDisplayName));

    let clientInfo = {
      name: isRealName ? rawDisplayName : 'Cliente',
      wasResolved: conversation.wasResolved || false,
    };

    if (conversation.client_id) {
      try {
        const ccRes = await query(
          "SELECT name, plan, wisphub_id, service_status, plan_price, wisphub_raw->>'usuario' as wisphub_usuario FROM clients WHERE id = $1",
          [conversation.client_id]
        );
        if (ccRes.rows.length) {
          const cc = ccRes.rows[0];
          const ccNameIsReal = cc.name && cc.name.includes(' ');
          const bestName = isRealName ? rawDisplayName : (ccNameIsReal ? cc.name : 'Cliente');
          clientInfo = { name: bestName, plan: cc.plan, wisphub_id: cc.wisphub_id, service_status: cc.service_status };
          if (cc.wisphub_id) {
            try {
              const planPrice = parseFloat(cc.plan_price) || null;
              const wisphubUsuario = cc.wisphub_usuario || null;
              const debtInfo = await wisphub.consultarDeuda(cc.wisphub_id, planPrice, wisphubUsuario);
              clientInfo.monto_mensual = debtInfo.monto_mensual;
              clientInfo.tiene_deuda   = debtInfo.tiene_deuda;
            } catch {}
          }
        }
      } catch (e) {
        logger.warn('No se pudo obtener clientInfo', { error: e.message });
      }
    }

    // Verificar si ya existe un pago reciente en esta conversación
    // Esto evita que la IA pida comprobante de nuevo si el cliente ya pagó
    try {
      const recentPayRes = await query(
        `SELECT status, amount, operation_code, created_at
         FROM payments
         WHERE conversation_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [conversation.id]
      );
      if (recentPayRes.rows.length) {
        clientInfo.recentPayment = recentPayRes.rows[0];
      }
    } catch {}

    // 5a. ¿Mensaje de cierre/agradecimiento? → auto-resolver
    if (RESOLVE_KEYWORDS.test(text.trim())) {
      // Verificar que ya hubo interacción previa (al menos un mensaje del bot)
      const prevBot = history.filter(m => m.sender_type === 'bot' || m.sender_type === 'agent');
      if (prevBot.length > 0) {
        const clientName = clientInfo.name !== 'Cliente' ? `, *${clientInfo.name}*` : '';
        const closeMsg = `¡De nada${clientName}! 😊 Si necesitas algo más, no dudes en escribirnos. *Fiber Perú* siempre disponible para ayudarte. 🌐`;
        await whatsapp.sendTextMessage(phone, closeMsg);
        await saveOutboundMessage(conversation.id, closeMsg, 'bot');
        await autoResolveConversation(conversation.id, 'agradecimiento_cliente');
        return;
      }
    }

    // 5. ¿Quiere hablar con humano?
    const quiereHumano = /asesor|agente|humano|persona|hablar con alguien|no entiendo/i.test(text);
    if (quiereHumano) {
      if (!isWithinBusinessHours()) {
        const msg = '🕐 Nuestros asesores atienden de *8:00 AM a 6:00 PM* de lunes a sábado. Por el momento el bot puede ayudarte con pagos y consultas. ¿En qué te puedo ayudar?';
        await whatsapp.sendTextMessage(phone, msg);
        await saveOutboundMessage(conversation.id, msg, 'bot');
        return;
      }
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

  // Formatear fecha: paymentDate puede ser "YYYY-MM-DD" o ISO; mostrar dd/mm/yyyy HH:mm
  const formatFecha = (raw) => {
    if (!raw) {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    try {
      const d = new Date(raw.includes('T') ? raw : raw + 'T12:00:00');
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    } catch { return raw; }
  };

  switch (result.status) {
    case 'success': {
      const metodo = (aiData.paymentMethod || aiData.method || 'N/A').toUpperCase().replace('_', ' ');
      return `✅ *Pago recibido correctamente*\n\n🧾 Factura: #${debt.factura_id || 'N/A'}\n💰 Monto: S/ ${aiData.amount}\n💳 Método: ${metodo}\n📅 Fecha: ${formatFecha(aiData.paymentDate)}\n🔢 Operación: ${aiData.operationCode || 'N/A'}\n\n¡Gracias por su pago! Su servicio ha sido actualizado. 🎉`;
    }

    case 'registered_no_debt':
      return `✅ *Pago registrado en el sistema*\n\n💰 Monto: S/ ${aiData.amount}\n🔢 Operación: ${aiData.operationCode || 'N/A'}\n\nNo encontramos facturas pendientes en tu cuenta en este momento. Para más información comunícate con soporte: *932258382* 😊`;

    case 'duplicate':
      return `⚠️ *Comprobante ya registrado*\n\nEste comprobante (código: ${aiData.operationCode || 'N/A'}) ya fue procesado anteriormente.\n\nSi crees que es un error, comunícate con soporte: *932258382*`;

    case 'unreadable':
      return `📸 La imagen no está clara. Por favor toma la foto con buena iluminación y que se vea el monto y el número de operación.\n\nIntenta de nuevo. 🔄`;

    case 'client_not_found':
      return `No encontramos tu número registrado como cliente de Fiber Perú.\n\nSi ya tienes contrato: *932258382*\nSi deseas contratar: *940366709* 😊`;

    case 'fraud_detected': {
      const año = aiData?.yearDetected || 'anterior';
      const fechaVoucher = aiData?.paymentDate || 'desconocida';
      const motivo = aiData?.futureDateFound
        ? `fecha futura (${fechaVoucher})`
        : `año ${año} en el comprobante`;
      return `⏳ Estamos demorando un poco en procesar tu pago. El administrador revisará tu comprobante y te confirmará pronto. 😊`;
    }

    case 'amount_mismatch': {
      const monthly = debt.monto_mensual;
      const hint = monthly
        ? `El monto de tu cuota mensual es *S/ ${monthly}*.`
        : `El monto no corresponde al de tu cuota actual.`;
      return `⚠️ El monto del comprobante (*S/ ${aiData.amount || 'N/A'}*) no coincide con tu cuota.\n\n${hint}\n\nPor favor envía el comprobante con el monto correcto o comunícate con soporte: *932258382*`;
    }

    case 'old_debt_only':
      return `⚠️ Detectamos pagos pendientes de *meses anteriores* en tu cuenta.\n\nPara regularizar tu servicio comunícate con un asesor: *932258382*`;

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
