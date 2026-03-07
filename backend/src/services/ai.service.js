const axios = require('axios');
const fs = require('fs');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// OPENAI CLIENT
// ─────────────────────────────────────────────────────────────

let openai = null;
const getOpenAI = () => {
  if (!openai && process.env.OPENAI_API_KEY) {
    const { OpenAI } = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
};

// ─────────────────────────────────────────────────────────────
// ANÁLISIS DE IMAGEN CON IA (OpenAI Vision gpt-4o)
// ─────────────────────────────────────────────────────────────

const analyzeVoucherWithAI = async (imagePath) => {
  const client = getOpenAI();
  if (!client) {
    logger.warn('OpenAI not configured for vision analysis');
    return null;
  }

  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    // Fecha actual dinámica para validación de año/mes
    const now = new Date();
    const currentYear  = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-12
    const currentDateStr = now.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 700,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Eres un sistema de verificación de comprobantes de pago de servicios de internet.

FECHA ACTUAL DEL SISTEMA: ${currentDateStr} (año ${currentYear}, mes ${currentMonth})

PASO 1 — Clasifica el tipo de imagen:
- "comprobante_pago": screenshot de Yape, Plin, transferencia bancaria, voucher de depósito/pago
- "imagen_tecnica": foto de router, cables de fibra, luces de equipo, instalación de red
- "otro": selfie, meme, documento no relacionado, captura sin relación a pagos o red

PASO 2 — Si es comprobante_pago, extrae y valida:

VALIDACIÓN DE AÑO (CRÍTICA):
- Lee el año que aparece en la fecha del comprobante
- Si el año NO es ${currentYear} → fraude_detectado: true, estado_voucher: "POSIBLE_FRAUDE"
- Razón: un ISP no acepta comprobantes de años anteriores (son reutilizados)

VALIDACIÓN DE MES:
- Extrae el número de mes de la fecha del comprobante (1=Enero … 12=Diciembre)
- Si mes_detectado != ${currentMonth} pero el año es correcto → estado_voucher: "MES_DIFERENTE"
  Esto es VÁLIDO (pago adelantado o de otro mes del mismo año)
- Si mes y año son correctos → estado_voucher: "VALIDO"

VALIDACIÓN DE FECHA FUTURA:
- Si la fecha del comprobante es posterior a hoy → fecha_futura: true, estado_voucher: "POSIBLE_FRAUDE"

Devuelve EXACTAMENTE este JSON (sin markdown, sin texto extra):
{
  "tipo_imagen": "comprobante_pago|imagen_tecnica|otro",
  "descripcion_tecnica": "descripción si es imagen_tecnica, sino null",
  "es_comprobante_valido": true/false,
  "medio_pago": "yape|plin|bcp|interbank|bbva|scotiabank|banBif|transferencia|desconocido",
  "monto": número o null,
  "moneda": "PEN|USD",
  "codigo_operacion": "string o null",
  "fecha": "YYYY-MM-DD o null",
  "hora": "HH:MM o null",
  "año_detectado": número o null,
  "mes_detectado": número 1-12 o null,
  "nombre_pagador": "string o null",
  "nombre_receptor": "string o null",
  "telefono": "string o null",
  "ultimos_digitos_tarjeta": "string o null",
  "fraude_detectado": true/false,
  "fecha_futura": true/false,
  "estado_voucher": "VALIDO|MES_DIFERENTE|POSIBLE_FRAUDE|REVISION_MANUAL",
  "motivo_estado": "explicación breve en español",
  "confianza": "alta|media|baja",
  "razon_invalido": "string si no es válido, sino null"
}

REGLAS IMPORTANTES:
- Solo extrae datos VISIBLES en la imagen, no inventes
- Para Yape/Plin: busca el monto grande central y el nombre del receptor
- El código de operación puede llamarse: N° operación, código, referencia, N° transacción
- Si la fecha no es legible → confianza: "baja", estado_voucher: "REVISION_MANUAL"
- Si la imagen no es comprobante → es_comprobante_valido: false, tipo_imagen: "otro" o "imagen_tecnica"`
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
    });

    const content = response.choices[0]?.message?.content || '';

    // Extraer JSON de la respuesta
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('AI Vision: no JSON found in response');
      return null;
    }

    const result = JSON.parse(jsonMatch[0]);
    logger.info('AI Vision analysis complete', {
      valid: result.es_comprobante_valido,
      method: result.medio_pago,
      amount: result.monto,
      confidence: result.confianza,
    });

    return {
      success: true,
      extraction_method: 'ai_vision',
      image_type: result.tipo_imagen || (result.es_comprobante_valido ? 'comprobante_pago' : 'otro'),
      tech_description: result.descripcion_tecnica || null,
      confidence: result.confianza === 'alta' ? 'high' : result.confianza === 'media' ? 'medium' : 'low',
      is_valid_voucher: result.es_comprobante_valido,
      paymentMethod: result.medio_pago,
      amount: result.monto,
      currency: result.moneda || 'PEN',
      operationCode: result.codigo_operacion,
      paymentDate: result.fecha,
      paymentTime: result.hora,
      payerName: result.nombre_pagador,
      receiverName: result.nombre_receptor,
      phone: result.telefono,
      cardLast4: result.ultimos_digitos_tarjeta,
      invalidReason: result.razon_invalido,
      // Nuevos campos de validación de fecha/fraude
      yearDetected:    result.año_detectado   || null,
      monthDetected:   result.mes_detectado   || null,
      fraudDetected:   result.fraude_detectado === true,
      futureDateFound: result.fecha_futura     === true,
      voucherStatus:   result.estado_voucher   || 'REVISION_MANUAL',
      voucherStatusReason: result.motivo_estado || null,
      rawData: result,
    };

  } catch (err) {
    logger.error('AI Vision analysis failed', { error: err.message });
    return null;
  }
};

// ─────────────────────────────────────────────────────────────
// TRANSCRIPCIÓN DE AUDIO (OpenAI Whisper)
// ─────────────────────────────────────────────────────────────

const transcribeAudio = async (audioPath) => {
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OpenAI not configured for audio transcription');
    return null;
  }

  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath));
    form.append('model', 'whisper-1');
    form.append('language', 'es');

    const { data } = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout: 30000,
      }
    );

    const transcript = data.text || null;
    if (transcript) {
      logger.info('Audio transcribed successfully', { length: transcript.length });
    }
    return transcript;
  } catch (err) {
    logger.error('Audio transcription failed', { error: err.message });
    return null;
  }
};

// ─────────────────────────────────────────────────────────────
// DETECCIÓN DE INTENCIÓN (simple fallback)
// ─────────────────────────────────────────────────────────────

const detectIntentSimple = (message) => {
  const text = message.toLowerCase();
  const patterns = {
    payment:   /pag[oa]|voucher|comprobante|yape|plin|transferencia|deposi|factura|deuda|cuota|cancelar|registrar/,
    support:   /internet|no funciona|lento|sin señal|desconect|no carga|caido|fibra|router|wifi|conexion|señal/,
    complaint: /reclamo|queja|molesto|enojado|pesimo|horrible|nunca|siempre|cansado|hartado|devolver|cobrar/,
    sales:     /plan|precio|contratar|nuevo|instalar|cuanto cuesta|velocidad|megas|fibra optica/,
    info:      /horario|direccion|telefono|correo|contacto|donde|cuando|informacion/,
    greeting:  /^(hola|buenos|buenas|buen dia|hi|hey|saludos|que tal|buenas tardes|buenas noches)/,
    cut:       /corta|cortaron|suspendido|suspension|reactivar|activar|sin internet por pago/,
  };
  for (const [intent, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) return { intent, confidence: 0.75 };
  }
  return { intent: 'unknown', confidence: 0.3 };
};

// ─────────────────────────────────────────────────────────────
// CHATBOT CONVERSACIONAL COMPLETO (GPT-4o)
// ─────────────────────────────────────────────────────────────

const generateConversationalResponse = async (userMessage, history = [], clientInfo = null) => {
  const client = getOpenAI();

  // Información del cliente para contexto
  const clientName    = clientInfo?.name || clientInfo?.nombre;
  const clientPlan    = clientInfo?.plan;
  const montoMensual  = clientInfo?.monto_mensual ?? clientInfo?.debt_amount ?? null;
  const serviceStatus = clientInfo?.service_status ?? 'activo';
  const recentPayment = clientInfo?.recentPayment ?? null;
  const wasResolved   = clientInfo?.wasResolved ?? false;

  // Solo mostrar cuota mensual — nunca deuda acumulada (confunde y alarma al cliente)
  let deudaTexto = 'sin datos en este momento';
  if (montoMensual != null) {
    if (montoMensual === 0) {
      deudaTexto = 'S/ 0.00 — cuenta al día ✅';
    } else {
      deudaTexto = `S/ ${montoMensual} — cuota mensual del servicio`;
    }
  }

  const serviceStatusLabel = serviceStatus === 'cortado'
    ? '⛔ CORTADO / SUSPENDIDO (debe pagar para reactivar)'
    : '✅ Activo';

  // Contexto de pago reciente (si existe)
  let recentPaymentContext = '';
  if (recentPayment) {
    const payStatusMap = {
      validated: 'VALIDADO ✅',
      success: 'EXITOSO ✅',
      registered_no_debt: 'REGISTRADO (sin facturas pendientes) ✅',
      duplicate: 'DUPLICADO ⚠️',
      pending: 'PENDIENTE DE REVISIÓN ⏳',
      processing: 'EN PROCESO ⏳',
      manual_review: 'EN REVISIÓN MANUAL 👨‍💼',
      rejected: 'RECHAZADO ❌',
      amount_mismatch: 'MONTO NO COINCIDE ⚠️',
    };
    const payLabel = payStatusMap[recentPayment.status] || recentPayment.status.toUpperCase();
    recentPaymentContext = `\nÚLTIMO PAGO EN ESTA CONVERSACIÓN: ${payLabel} — Monto: S/ ${recentPayment.amount || 'N/A'} — Op: ${recentPayment.operation_code || 'N/A'}`;
  }

  const resolvedContext = wasResolved
    ? '\n⚠️ CONTEXTO: Esta conversación estaba RESUELTA y el cliente escribió de nuevo. Salúdalo brevemente y pregunta en qué puedes ayudarle ahora. Usa el historial para recordar el problema anterior.'
    : '';

  const clientContext = clientName
    ? `╔══════════════════════════════════════════╗
║   DATOS EN TIEMPO REAL DEL SISTEMA       ║
║   (ESTOS DATOS ANULAN CUALQUIER MONTO    ║
║    MENCIONADO EN EL HISTORIAL)           ║
╚══════════════════════════════════════════╝
- Nombre: ${clientName}
- Plan: ${clientPlan || 'no registrado'}
- Estado del servicio: ${serviceStatusLabel}
- Cuota mensual ACTUAL: ${deudaTexto}${recentPaymentContext}`
    : 'CLIENTE: no identificado en el sistema (puede ser número no registrado o nuevo)';

  const { getPaymentBlock } = require('../config/payment-info');

  const systemPrompt = `Eres el asistente oficial de atención al cliente de Fiber Perú (ISP de internet por fibra óptica).
Tu único propósito es ayudar a clientes con temas de: internet por fibra óptica, routers, WiFi, pagos, deudas, vouchers, planes, instalación y soporte técnico.

${clientContext}${resolvedContext}

MÉTODOS DE PAGO FIBER PERU:
${getPaymentBlock()}

CONTACTOS IMPORTANTES:
- Soporte técnico: *932258382* (WhatsApp/llamada)
- Ventas y nuevos planes: *940366709* (WhatsApp/llamada)
- Web: fiber-peru.com

═══════════════════════════════
REGLAS ESTRICTAS:
═══════════════════════════════
1. NUNCA respondas temas fuera del rubro ISP (programación, tareas, política, religión, juegos, etc.).
   Si preguntan algo ajeno: "Solo puedo ayudarte con temas de tu servicio de internet, pagos o soporte técnico."
2. NUNCA inventes nombres, montos ni datos. Solo usa lo que está en el sistema.
3. NUNCA menciones bases de datos, APIs, OpenAI, sistemas internos ni procesos técnicos.
4. Habla como un asesor humano de Fiber Perú. Español claro, sencillo, respetuoso.
5. Respuestas cortas y útiles. RESPONDE EXACTAMENTE A LO QUE EL CLIENTE DIJO.
6. CRÍTICO: Si arriba aparece "CLIENTE IDENTIFICADO", ese cliente SÍ está registrado en WispHub.
   NUNCA digas "no estás registrado" ni "no encontré tu número" cuando ya tienes su nombre.
   El nombre oficial del contrato es el que está en WispHub, aunque el cliente diga otro diferente.
7. SERVICIO CORTADO: Si el estado del servicio dice "CORTADO/SUSPENDIDO", infórmale amablemente
   que su servicio está suspendido y que al pagar y enviar el comprobante, lo reactivamos en minutos.

═══════════════════════════════
VARIEDAD Y MEMORIA:
═══════════════════════════════
- NUNCA repitas la misma frase de apertura que usaste antes ("¡Hola!", "¡Claro!", "Por supuesto!" — varíalas)
- NUNCA copies textualmente una respuesta que ya enviaste en esta conversación
- Si el cliente pregunta algo que ya explicaste antes: "Como te comenté, ..." y resume brevemente
- Adapta tu tono al historial: si ya llevan rato hablando, sé más directo y menos formal
- Usa el nombre del cliente cuando ya lo sabes, pero no lo repitas en CADA mensaje (solo a veces)

═══════════════════════════════
CÓMO RESPONDER SEGÚN EL MENSAJE:
═══════════════════════════════

1. SALUDO (hola, buenas tardes, buenas noches, buenos días, etc.):
   → Devuelve el mismo saludo. Si el cliente está identificado, usa su nombre.
   → Ejemplo: "¡Buenas tardes, [Nombre]! 😊 ¿En qué puedo ayudarte hoy?"
   → NO menciones deuda ni servicio a menos que el cliente lo pregunte.

2. CONSULTA DE CUOTA/PAGO (¿cuánto debo?, ¿mi cuota?, ¿cuánto es?):
   → USA EXACTAMENTE el valor de "Cuota mensual ACTUAL" del bloque de arriba. NUNCA uses montos del historial.
   → Si el historial menciona un monto diferente, IGNÓRALO — el sistema ya actualizó los datos.
   → Responde SOLO con la cuota mensual: "Tu cuota mensual es S/ [monto]. Envíanos tu comprobante de pago."
   → NUNCA menciones deuda total, número de facturas acumuladas ni montos de meses anteriores.
   → Si el cliente pregunta por meses anteriores o deuda acumulada: "Para regularizar pagos anteriores comunícate con un asesor: *932258382*"
   → Si no hay deuda: "[Nombre], tu servicio está al día. 😊"
   → Sin datos: "En este momento no puedo consultar. Comunícate con soporte: *932258382*"

3. SOPORTE TÉCNICO (internet lento, caído, sin señal, router, etc.):
   → Pregunta: ¿tienes internet ahora o está totalmente caído? ¿La luz LOS/PON del router está roja?
   → Pasos básicos: reiniciar router (desconectar 30 seg), verificar cables de fibra y corriente, probar otro dispositivo.
   → Si no se soluciona: "Te conecto con soporte técnico: *932258382* ⏱️"

4. CLIENTE DICE QUE YA PAGÓ (escribe texto, NO envía imagen):
   → PRIMERO verifica si arriba dice "ÚLTIMO PAGO EN ESTA CONVERSACIÓN":
     - Si hay un pago REGISTRADO/VALIDADO/EXITOSO reciente → el cliente ya pagó. NO pidas comprobante.
       Responde: "Tu pago ya fue recibido y registrado. ✅ ¿En qué más puedo ayudarte?"
     - Si NO hay pago previo registrado → pide la foto:
       "Para registrar tu pago, envíame la *foto o captura* de tu comprobante 📸
        (screenshot de Yape, Plin, BCP, Interbank, etc.)"
   → NUNCA digas "hemos recibido tu comprobante" si no llegó una imagen real Y no hay pago previo.
   → NUNCA confirmes un pago solo porque el cliente escribió que pagó (sin imagen Y sin pago previo).

5. PIDE HABLAR CON UN HUMANO:
   → "Entendido, te conecto con un asesor ahora mismo. Un momento. 👨‍💼"

6. CLIENTE DICE QUE SU NOMBRE ES DIFERENTE al que tenemos registrado:
   → "Nuestro sistema tiene este número registrado a nombre de *[nombre del sistema]*. Si hay un error en el registro, comunícate con soporte: *932258382* 😊"
   → NUNCA digas que no está registrado. Sí lo está, solo puede haber un error en los datos.

7. CLIENTE NO IDENTIFICADO (cuando NO hay nombre en el bloque de arriba):
   → "Hola, gracias por contactarnos. 😊 Tu número no está registrado como cliente activo de Fiber Perú."
   → Pide amablemente: nombre completo y dirección o referencia para buscar en el sistema.
   → Si tampoco se encuentra: ofrecer ventas al *940366709* o fiber-peru.com`;

  if (!client) {
    // Fallback sin OpenAI
    const { intent } = detectIntentSimple(userMessage);
    return { text: getFallbackResponse(intent), used_ai: false };
  }

  try {
    // Construir historial de conversación (últimos 25 mensajes — incluye sesiones anteriores)
    const conversationHistory = history.slice(-25).map(m => ({
      role: m.sender_type === 'client' ? 'user' : 'assistant',
      content: m.body || '',
    })).filter(m => m.content);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ];

    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      max_tokens: 350,
      temperature: 0.85,
    });

    const text = response.choices[0]?.message?.content || getFallbackResponse('unknown');
    logger.debug('AI chatbot response generated', { tokens: response.usage?.total_tokens });

    return { text, used_ai: true };

  } catch (err) {
    logger.warn('AI chatbot failed, using fallback', { error: err.message });
    const { intent } = detectIntentSimple(userMessage);
    return { text: getFallbackResponse(intent), used_ai: false };
  }
};

// ─────────────────────────────────────────────────────────────
// RESPUESTAS DE FALLBACK (sin IA)
// ─────────────────────────────────────────────────────────────

const getFallbackResponse = (intent) => {
  const RESPONSES = {
    greeting: `¡Hola! Soy el asistente de Fiber Peru. 😊

¿En qué puedo ayudarte?
• Consultar tu deuda
• Registrar tu pago (envíanos el comprobante)
• Soporte técnico: *932258382*
• Planes y ventas: *940366709*`,

    payment: `Para registrar tu pago, envíanos la foto de tu comprobante (Yape, Plin, BCP, Interbank). ✅

Asegúrate que se vea el monto, número de operación y fecha.`,

    support: `Entiendo que tienes problemas con tu internet.

Por favor intenta:
1. Apagar y encender el router (espera 30 segundos)
2. Verificar que los cables estén bien conectados

Si el problema persiste, comunícate con soporte: *932258382* ⏱️`,

    complaint: `Lamentamos los inconvenientes. 😔

Un asesor revisará tu caso. También puedes llamar a soporte: *932258382*`,

    sales: `Para conocer nuestros planes de internet, comunícate con ventas: *940366709* 😊

O visita: fiber-peru.com`,

    cut: `Tu servicio fue suspendido por falta de pago.

Para reactivarlo:
1. Realiza tu pago (Yape, Plin, BCP, Interbank)
2. Envíanos la foto del comprobante
3. Nuestro equipo lo validará en breve ✅`,

    not_client: `Hola, gracias por contactarnos.

Tu número no está registrado como cliente de Fiber Peru. Si deseas conocer nuestros planes de internet, comunícate con ventas: *940366709* o visita fiber-peru.com 😊`,

    unknown: `Hola, soy el asistente de Fiber Peru. Solo puedo ayudarte con temas del servicio. 😊

¿Qué necesitas?
• Consultar tu deuda
• Registrar un pago
• Soporte técnico: *932258382*
• Planes y ventas: *940366709*`,
  };
  return RESPONSES[intent] || RESPONSES.unknown;
};

// ─────────────────────────────────────────────────────────────
// DETECTAR INTENCIÓN (para decidir si escalar o no)
// ─────────────────────────────────────────────────────────────

const detectIntent = async (message, history = []) => {
  const client = getOpenAI();
  if (!client) return detectIntentSimple(message);

  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Clasifica el mensaje del cliente de un ISP peruano en UNA categoría:
payment|support|complaint|sales|info|greeting|cut|unknown
Responde SOLO JSON: {"intent":"categoria","confidence":0.0-1.0}`,
          },
          ...history.slice(-3).map(m => ({
            role: m.sender_type === 'client' ? 'user' : 'assistant',
            content: m.body || '',
          })),
          { role: 'user', content: message },
        ],
        max_tokens: 50,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );

    return JSON.parse(data.choices[0].message.content);
  } catch {
    return detectIntentSimple(message);
  }
};

module.exports = {
  analyzeVoucherWithAI,
  transcribeAudio,
  generateConversationalResponse,
  detectIntent,
  getFallbackResponse,
};
