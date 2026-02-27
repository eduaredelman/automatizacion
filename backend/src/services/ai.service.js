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

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analiza este comprobante de pago peruano y extrae los datos en formato JSON.

Extrae exactamente:
{
  "es_comprobante_valido": true/false,
  "medio_pago": "yape|plin|bcp|interbank|bbva|scotiabank|banBif|transferencia|desconocido",
  "monto": número o null,
  "moneda": "PEN" o "USD",
  "codigo_operacion": "string o null",
  "fecha": "YYYY-MM-DD o null",
  "hora": "HH:MM o null",
  "nombre_pagador": "string o null",
  "nombre_receptor": "string o null",
  "telefono": "string o null",
  "ultimos_digitos_tarjeta": "string o null",
  "confianza": "alta|media|baja",
  "razon_invalido": "string si no es válido, sino null"
}

IMPORTANTE:
- Si es screenshot de Yape/Plin, busca el monto grande en la pantalla
- El código de operación puede llamarse: N° operación, código, referencia, número de transacción
- Fecha actual: ${new Date().toLocaleDateString('es-PE')}
- Solo extrae datos que están VISIBLES en la imagen
- Si la imagen no es un comprobante de pago, marca es_comprobante_valido: false`
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
      rawData: result,
    };

  } catch (err) {
    logger.error('AI Vision analysis failed', { error: err.message });
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
  const clientName = clientInfo?.name || clientInfo?.nombre;
  const clientPlan = clientInfo?.plan;
  const clientDebt = clientInfo?.debt_amount ?? clientInfo?.deuda;

  const clientContext = clientName
    ? `CLIENTE IDENTIFICADO:
- Nombre: ${clientName}
- Plan: ${clientPlan || 'no registrado'}
- Deuda pendiente: ${clientDebt != null ? `S/ ${clientDebt}` : 'sin datos en este momento'}`
    : 'CLIENTE: no identificado en el sistema (puede ser número no registrado o nuevo)';

  const { getPaymentBlock } = require('../config/payment-info');

  const systemPrompt = `Eres el asistente automático oficial de Fiber Peru, empresa de internet por fibra óptica en Perú.

${clientContext}

MÉTODOS DE PAGO FIBER PERU:
${getPaymentBlock()}

CONTACTOS IMPORTANTES:
- Soporte técnico: *932258382* (WhatsApp/llamada)
- Ventas y nuevos planes: *940366709* (WhatsApp/llamada)
- Web: fiber-peru.com

═══════════════════════════════
REGLAS ESTRICTAS:
═══════════════════════════════
- Responde SOLO sobre servicios de Fiber Peru. Si preguntan otra cosa: "Solo puedo ayudarte con temas del servicio Fiber Peru. 😊"
- NUNCA inventes nombres, montos ni datos. Solo usa lo que está en el sistema.
- NUNCA menciones "análisis de imagen", "IA", "inteligencia artificial" ni procesos internos.
- Respuestas cortas y claras (máximo 4 líneas).

═══════════════════════════════
FLUJO SEGÚN TIPO DE CLIENTE:
═══════════════════════════════

SI EL CLIENTE ESTÁ REGISTRADO EN EL SISTEMA (tiene nombre):
1. Salúdalo SIEMPRE por su nombre: "Hola [Nombre], ..."
2. Si no tiene deuda: "Hola [Nombre], tu servicio está activo y no tienes deuda pendiente. Gracias por confiar en Fiber Peru."
3. Si tiene deuda: "Hola [Nombre], registramos un saldo pendiente de S/ [monto]. Puedes enviarnos tu comprobante de pago por este medio."
4. Si pregunta por soporte técnico: brinda pasos básicos y da el número *932258382*
5. Si envió comprobante: "Gracias [Nombre], hemos recibido tu comprobante. Nuestro equipo lo validará en breve."

SI EL NÚMERO NO ESTÁ REGISTRADO (cliente potencial/nuevo):
- No es cliente activo aún. Ofrécele los planes y datos de contacto de ventas.
- Responde: "Hola, gracias por contactarnos. Por el momento tu número no está registrado como cliente de Fiber Peru. Si deseas conocer nuestros planes de internet, comunícate con ventas al *940366709* o visita fiber-peru.com 😊"
- NO intentes registrarlo ni pedirle datos.`;

  if (!client) {
    // Fallback sin OpenAI
    const { intent } = detectIntentSimple(userMessage);
    return { text: getFallbackResponse(intent), used_ai: false };
  }

  try {
    // Construir historial de conversación (últimos 10 mensajes)
    const conversationHistory = history.slice(-10).map(m => ({
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
      max_tokens: 300,
      temperature: 0.7,
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
  generateConversationalResponse,
  detectIntent,
  getFallbackResponse,
};
