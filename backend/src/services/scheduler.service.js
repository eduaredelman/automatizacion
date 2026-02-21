/**
 * SCHEDULER SERVICE - FiberPeru
 *
 * Trabajos automáticos programados:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Días 1-5  │ 8:00 AM │ Aviso de cobro a todos los clientes │
 * │  Día 10    │ 9:00 AM │ Corte automático por falta de pago  │
 * │  Diario    │ 7:00 AM │ Sincronizar clientes de WispHub     │
 * └─────────────────────────────────────────────────────────────┘
 */

const cron = require('node-cron');
const { query } = require('../config/database');
const wisphub = require('./wisphub.service');
const whatsapp = require('./whatsapp.service');
const logger = require('../utils/logger');
const { getPaymentBlock } = require('../config/payment-info');

// ─────────────────────────────────────────────────────────────
// MENSAJES DE COBRO (días 1 al 5)
// ─────────────────────────────────────────────────────────────

const MENSAJE_COBRO_DIA = {
  1: (nombre, monto) => {
    const pagos = getPaymentBlock();
    return `¡Hola ${nombre || 'estimado cliente'}! 👋

Tu factura de *FiberPeru* del mes está disponible.
💰 Monto: *S/ ${monto || '...'} PEN*

Puedes pagar por cualquiera de estos medios:
${pagos}

📸 Envíanos la foto del comprobante a este chat y lo registramos al instante. ✅`;
  },

  2: (nombre, monto) => {
    const pagos = getPaymentBlock();
    return `Hola ${nombre || ''} 😊

Recordatorio: tienes una factura pendiente con *FiberPeru*.
💰 Total a pagar: *S/ ${monto || '...'} PEN*

Métodos de pago disponibles:
${pagos}

¿Ya pagaste? Envíanos la foto del voucher y lo procesamos de inmediato. 📸`;
  },

  3: (nombre, monto) => {
    const pagos = getPaymentBlock();
    return `${nombre || 'Cliente'}, 📋 tu factura de *FiberPeru* vence pronto.

💰 Monto: *S/ ${monto || '...'} PEN*

Paga hoy usando:
${pagos}

Envía la foto del comprobante a este chat. ✅`;
  },

  4: (nombre, monto) => {
    const pagos = getPaymentBlock();
    return `⚠️ ${nombre || 'Estimado cliente'},

Tu factura de *FiberPeru* está próxima a vencer.
💰 Monto pendiente: *S/ ${monto || '...'} PEN*

*Si no realizas el pago antes del día 10, tu servicio será suspendido automáticamente.*

Paga ahora y evita el corte:
${pagos}

📸 Envíanos el voucher a este chat.`;
  },

  5: (nombre, monto) => {
    const pagos = getPaymentBlock();
    return `🚨 *ÚLTIMO AVISO* - ${nombre || 'Cliente FiberPeru'}

Tu servicio de internet será *CORTADO EL DÍA 10* si no pagas.
💰 Deuda: *S/ ${monto || '...'} PEN*

Para evitar el corte, paga HOY:
${pagos}

Luego envíanos la foto del comprobante aquí y lo activamos de inmediato ✅
¿Necesitas ayuda? Responde este mensaje.`;
  },
};

const MENSAJE_CORTE = (nombre) => {
  const pagos = getPaymentBlock();
  return `📵 ${nombre || 'Estimado cliente'},

Tu servicio de internet *FiberPeru ha sido suspendido* por falta de pago.

Para *reactivarlo inmediatamente*, realiza tu pago:
${pagos}

Luego envía la foto del comprobante a este chat y reactivamos tu servicio en minutos ✅

¿Tienes dudas? Responde este mensaje y un asesor te ayuda.`;
};

// ─────────────────────────────────────────────────────────────
// JOB: Enviar avisos de cobro (días 1 al 5)
// ─────────────────────────────────────────────────────────────

const enviarAvisosCobro = async () => {
  const dia = new Date().getDate();

  if (dia < 1 || dia > 5) {
    logger.debug(`Scheduler: día ${dia} no requiere aviso de cobro`);
    return;
  }

  logger.info(`[SCHEDULER] Iniciando envío de avisos de cobro - Día ${dia}`);

  try {
    // Obtener facturas pendientes directamente de WispHub
    const facturasPendientes = await wisphub.obtenerClientesConDeuda();

    if (!facturasPendientes.length) {
      logger.info('[SCHEDULER] No hay facturas pendientes para notificar');
      return;
    }

    logger.info(`[SCHEDULER] Enviando avisos a ${facturasPendientes.length} clientes`);

    let enviados = 0;
    let errores = 0;

    for (const factura of facturasPendientes) {
      try {
        // Obtener datos del cliente
        const clienteId = factura.id_servicio || factura.cliente_id;
        if (!clienteId) continue;

        // Buscar teléfono del cliente
        let phone = null;

        // El teléfono puede venir en la factura o necesitamos buscarlo
        if (factura.celular || factura.telefono) {
          phone = wisphub.obtenerTelefonoCliente(factura);
        } else {
          // Buscar cliente por ID
          try {
            const { data } = await require('axios').get(
              `${process.env.WISPHUB_API_URL}/clientes/${clienteId}/`,
              { headers: { Authorization: `Api-Key ${process.env.WISPHUB_API_TOKEN}` }, timeout: 10000 }
            );
            phone = wisphub.obtenerTelefonoCliente(data);
          } catch {
            logger.warn(`Could not fetch client ${clienteId} for notification`);
            continue;
          }
        }

        if (!phone) {
          logger.warn(`No phone for client ${clienteId}`);
          continue;
        }

        const monto = factura.monto || factura.total;
        const nombre = factura.nombre || factura.cliente_nombre || '';
        const mensajeFn = MENSAJE_COBRO_DIA[dia] || MENSAJE_COBRO_DIA[5];
        const mensaje = mensajeFn(nombre, monto);

        // Enviar mensaje por WhatsApp
        await whatsapp.sendTextMessage(phone, mensaje);

        // Registrar en DB que se envió el aviso
        await query(
          `INSERT INTO events (event_type, description, metadata)
           VALUES ('payment_reminder_sent', $1, $2)`,
          [
            `Aviso día ${dia} enviado a ${phone}`,
            JSON.stringify({ phone, clienteId, dia, monto }),
          ]
        ).catch(() => {}); // No bloquear si falla el log

        enviados++;

        // Rate limiting: esperar 500ms entre mensajes
        // WhatsApp permite ~80 mensajes por segundo en Cloud API
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        errores++;
        logger.warn(`[SCHEDULER] Error enviando a cliente`, { error: err.message });
        // Esperar un poco más si hay error (puede ser throttling)
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    logger.info(`[SCHEDULER] Avisos completados: ${enviados} enviados, ${errores} errores`);

  } catch (err) {
    logger.error('[SCHEDULER] Error crítico en enviarAvisosCobro', { error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// JOB: Corte automático día 10
// ─────────────────────────────────────────────────────────────

const ejecutarCorteAutomatico = async () => {
  const dia = new Date().getDate();

  if (dia !== 10) {
    logger.debug(`Scheduler: día ${dia}, corte automático solo el día 10`);
    return;
  }

  logger.info('[SCHEDULER] ⚠️  INICIANDO CORTE AUTOMÁTICO DÍA 10');

  try {
    const facturasPendientes = await wisphub.obtenerClientesConDeuda();

    if (!facturasPendientes.length) {
      logger.info('[SCHEDULER] No hay clientes para cortar servicio');
      return;
    }

    logger.info(`[SCHEDULER] Procesando corte para ${facturasPendientes.length} clientes`);

    let cortados = 0;
    let errores = 0;

    for (const factura of facturasPendientes) {
      try {
        const clienteId = factura.id_servicio || factura.cliente_id;
        if (!clienteId) continue;

        // 1. Cortar servicio en WispHub
        const corteResult = await wisphub.cortarServicio(clienteId, 'Falta de pago - Corte automático día 10');

        // 2. Buscar teléfono y notificar
        const phone = wisphub.obtenerTelefonoCliente(factura);
        if (phone) {
          const nombre = factura.nombre || factura.cliente_nombre || '';
          await whatsapp.sendTextMessage(phone, MENSAJE_CORTE(nombre));
          await new Promise(r => setTimeout(r, 500));
        }

        // 3. Log en DB
        await query(
          `INSERT INTO events (event_type, description, metadata)
           VALUES ('service_cut', $1, $2)`,
          [
            `Corte automático día 10 - cliente ${clienteId}`,
            JSON.stringify({ clienteId, phone, success: corteResult.success }),
          ]
        ).catch(() => {});

        cortados++;
        logger.info(`[SCHEDULER] Servicio cortado: cliente ${clienteId}`);

      } catch (err) {
        errores++;
        logger.error(`[SCHEDULER] Error al cortar servicio`, { error: err.message });
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    logger.info(`[SCHEDULER] Corte completado: ${cortados} cortados, ${errores} errores`);

  } catch (err) {
    logger.error('[SCHEDULER] Error crítico en ejecutarCorteAutomatico', { error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// JOB: Sincronizar clientes de WispHub a DB local
// ─────────────────────────────────────────────────────────────

const sincronizarClientes = async () => {
  logger.info('[SCHEDULER] Sincronizando clientes de WispHub...');

  try {
    const clientes = await wisphub.obtenerTodosLosClientes({ soloActivos: true });

    let actualizados = 0;
    for (const cliente of clientes) {
      try {
        const clienteId = cliente.id_servicio || cliente.id;
        const phone = wisphub.obtenerTelefonoCliente(cliente);

        await query(
          `INSERT INTO clients (wisphub_id, phone, name, service_id, plan, last_synced_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (wisphub_id) DO UPDATE SET
             phone = EXCLUDED.phone,
             name = EXCLUDED.name,
             plan = EXCLUDED.plan,
             last_synced_at = NOW()`,
          [
            String(clienteId),
            phone || '',
            cliente.nombre || cliente.nombre_completo || 'N/A',
            String(clienteId),
            cliente.plan || cliente.plan_nombre || null,
          ]
        );
        actualizados++;
      } catch (err) {
        logger.warn('Failed to sync client', { error: err.message });
      }
    }

    logger.info(`[SCHEDULER] Sincronización completa: ${actualizados}/${clientes.length} clientes actualizados`);
  } catch (err) {
    logger.error('[SCHEDULER] Error en sincronizarClientes', { error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// INICIALIZAR TODOS LOS CRON JOBS
// ─────────────────────────────────────────────────────────────

const initScheduler = () => {
  logger.info('[SCHEDULER] Inicializando trabajos programados...');

  // ── Días 1-5: Avisos de cobro a las 8:00 AM (hora Perú UTC-5)
  // Cron: minuto hora dia mes díaSemana
  // '0 13 1-5 * *' = 8:00 AM Perú (13:00 UTC)
  cron.schedule('0 13 1-5 * *', async () => {
    logger.info('[CRON] Ejecutando: avisos de cobro días 1-5');
    await enviarAvisosCobro();
  }, {
    timezone: 'America/Lima',
  });

  // ── Día 10: Corte automático a las 9:00 AM
  cron.schedule('0 9 10 * *', async () => {
    logger.info('[CRON] Ejecutando: corte automático día 10');
    await ejecutarCorteAutomatico();
  }, {
    timezone: 'America/Lima',
  });

  // ── Diario: Sincronizar clientes a las 7:00 AM
  cron.schedule('0 7 * * *', async () => {
    logger.info('[CRON] Ejecutando: sincronización de clientes');
    await sincronizarClientes();
  }, {
    timezone: 'America/Lima',
  });

  logger.info('[SCHEDULER] ✅ Trabajos programados activos:');
  logger.info('  📅 Días 1-5 a las 8:00 AM → Avisos de cobro');
  logger.info('  ✂️  Día 10 a las 9:00 AM  → Corte automático');
  logger.info('  🔄 Diario a las 7:00 AM  → Sincronizar clientes');
};

// Exportar también para ejecución manual desde panel
module.exports = {
  initScheduler,
  enviarAvisosCobro,
  ejecutarCorteAutomatico,
  sincronizarClientes,
};
