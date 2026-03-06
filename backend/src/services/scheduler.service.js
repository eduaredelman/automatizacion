/**
 * SCHEDULER SERVICE - FiberPeru
 *
 * Trabajos automáticos programados:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Días 1-5  │ 8:00 AM Lima │ Aviso de cobro                 │
 * │  Día 10    │ 9:00 AM Lima │ Corte automático por falta pago │
 * │  Cada 5min │              │ Sincronizar clientes WispHub    │
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

/**
 * @param {{ force?: boolean }} opts
 *   force=true → omite el chequeo de días 1-5 (para ejecución manual del panel)
 */
const enviarAvisosCobro = async ({ force = false } = {}) => {
  const dia = new Date().getDate();

  if (!force && (dia < 1 || dia > 5)) {
    logger.debug(`Scheduler: día ${dia} no requiere aviso de cobro`);
    return { skipped: true, reason: `Día ${dia} fuera del rango 1-5` };
  }

  logger.info(`[SCHEDULER] Iniciando avisos de cobro - Día ${dia}${force ? ' (manual/forzado)' : ''}`);

  try {
    // ── Paso 1: Obtener montos de deuda desde WispHub ──────────────────────
    // Solo usamos WispHub para saber CUÁNTO deben, no para buscar teléfonos.
    const facturasPorServicio = {}; // { wisphub_id → { monto, nombre } }

    try {
      const facturas = await wisphub.obtenerClientesConDeuda();
      logger.info(`[SCHEDULER] WispHub retornó ${facturas.length} facturas pendientes`);

      for (const f of facturas) {
        const idServicio = String(
          f.id_servicio          ||
          f.cliente?.id_servicio ||
          f.cliente_id           || ''
        );
        if (!idServicio) continue;

        const monto  = f.total || f.sub_total || f.monto_total || f.monto;
        const nombre = f.cliente?.nombre || f.cliente?.nombre_completo ||
                       f.nombre || f.cliente_nombre || '';

        if (!facturasPorServicio[idServicio]) {
          facturasPorServicio[idServicio] = { monto, nombre };
        }
      }

      logger.info(`[SCHEDULER] Mapeados ${Object.keys(facturasPorServicio).length} clientes con deuda`);
    } catch (err) {
      logger.warn('[SCHEDULER] No se pudo consultar WispHub facturas, se usará solo DB local', {
        error: err.message,
      });
    }

    const wispIds = Object.keys(facturasPorServicio);

    // ── Paso 2: Obtener clientes con teléfono desde DB local ───────────────
    // La tabla clients tiene 1121+ contactos sincronizados con teléfonos normalizados.
    // Es MUCHO más confiable que extraer teléfonos de las facturas de WispHub.
    let dbQuery, dbParams;

    if (wispIds.length > 0) {
      // Tenemos lista de morosos de WispHub → solo notificar a esos
      dbQuery  = `SELECT wisphub_id, phone, name, debt_amount
                  FROM clients
                  WHERE wisphub_id = ANY($1::text[])
                    AND phone IS NOT NULL AND phone != ''`;
      dbParams = [wispIds];
    } else {
      // WispHub no devolvió datos → usar clientes de DB local
      if (dia === 1) {
        // Día 1: aviso general a todos los clientes activos
        dbQuery  = `SELECT wisphub_id, phone, name, debt_amount
                    FROM clients
                    WHERE wisphub_id IS NOT NULL
                      AND phone IS NOT NULL AND phone != ''
                      AND (service_status IS NULL OR service_status != 'cortado')`;
        dbParams = [];
      } else {
        // Días 2-5 sin WispHub: solo quienes tienen deuda registrada localmente
        dbQuery  = `SELECT wisphub_id, phone, name, debt_amount
                    FROM clients
                    WHERE wisphub_id IS NOT NULL
                      AND phone IS NOT NULL AND phone != ''
                      AND debt_amount > 0`;
        dbParams = [];
      }
    }

    const { rows: clientes } = await query(dbQuery, dbParams);

    if (!clientes.length) {
      logger.info('[SCHEDULER] No hay clientes para notificar (lista vacía)');
      return { enviados: 0, errores: 0, total: 0, skipped: false };
    }

    logger.info(`[SCHEDULER] Enviando avisos a ${clientes.length} clientes`);

    let enviados = 0;
    let errores  = 0;

    for (const cliente of clientes) {
      try {
        const wispData = facturasPorServicio[cliente.wisphub_id] || {};
        const monto    = wispData.monto  ?? cliente.debt_amount;
        const nombre   = wispData.nombre || cliente.name || '';
        const phone    = cliente.phone;

        const mensajeFn = MENSAJE_COBRO_DIA[dia] || MENSAJE_COBRO_DIA[5];
        const mensaje   = mensajeFn(nombre, monto);

        await whatsapp.sendTextMessage(phone, mensaje);

        // Registrar en events (conversation_id es nullable, no necesita valor)
        await query(
          `INSERT INTO events (event_type, description, metadata)
           VALUES ('payment_reminder_sent', $1, $2)`,
          [
            `Aviso día ${dia} enviado a ${phone}`,
            JSON.stringify({ phone, wisphub_id: cliente.wisphub_id, dia, monto }),
          ]
        ).catch(() => {});

        enviados++;

        // 500ms entre mensajes (respetar límites de Meta WhatsApp Cloud API)
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        errores++;
        logger.warn(`[SCHEDULER] Error enviando a ${cliente.phone}`, { error: err.message });
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    logger.info(`[SCHEDULER] Avisos completados: ${enviados} enviados, ${errores} errores, ${clientes.length} total`);
    return { enviados, errores, total: clientes.length, skipped: false };

  } catch (err) {
    logger.error('[SCHEDULER] Error crítico en enviarAvisosCobro', { error: err.message });
    return { enviados: 0, errores: 1, total: 0, skipped: false, error: err.message };
  }
};

// ─────────────────────────────────────────────────────────────
// JOB: Corte automático día 10
// ─────────────────────────────────────────────────────────────

const ejecutarCorteAutomatico = async ({ force = false } = {}) => {
  const dia = new Date().getDate();

  if (!force && dia !== 10) {
    logger.debug(`Scheduler: día ${dia}, corte automático solo el día 10`);
    return { skipped: true, reason: `Día ${dia} ≠ 10` };
  }

  logger.info(`[SCHEDULER] ⚠️  INICIANDO CORTE AUTOMÁTICO${force ? ' (manual/forzado)' : ' DÍA 10'}`);

  try {
    // Obtener clientes con deuda (para determinar quién cortar)
    const facturas = await wisphub.obtenerClientesConDeuda();

    if (!facturas.length) {
      logger.info('[SCHEDULER] No hay clientes para cortar servicio');
      return { cortados: 0, errores: 0, total: 0, skipped: false };
    }

    // Mapear id_servicio para lookup rápido
    const wispIds = [...new Set(facturas.map(f =>
      String(f.id_servicio || f.cliente?.id_servicio || '')
    ).filter(Boolean))];

    // Obtener teléfonos/nombres de DB local
    const { rows: clientesDB } = await query(
      `SELECT wisphub_id, phone, name FROM clients
       WHERE wisphub_id = ANY($1::text[])
         AND phone IS NOT NULL AND phone != ''`,
      [wispIds]
    );
    const clientesPorId = Object.fromEntries(clientesDB.map(c => [c.wisphub_id, c]));

    logger.info(`[SCHEDULER] Procesando corte para ${facturas.length} facturas`);

    let cortados = 0;
    let errores  = 0;

    for (const factura of facturas) {
      try {
        const idServicio = String(
          factura.id_servicio || factura.cliente?.id_servicio || ''
        );
        if (!idServicio) continue;

        // 1. Cortar servicio en WispHub
        const corteResult = await wisphub.cortarServicio(idServicio, 'Falta de pago - Corte automático día 10');

        // 2. Notificar al cliente por WhatsApp
        const clienteDB  = clientesPorId[idServicio];
        const clienteObj = factura.cliente || factura;
        const phone      = clienteDB?.phone || wisphub.obtenerTelefonoCliente(clienteObj);
        const nombre     = clienteDB?.name  || clienteObj.nombre || clienteObj.nombre_completo || '';

        if (phone) {
          await whatsapp.sendTextMessage(phone, MENSAJE_CORTE(nombre));
          await new Promise(r => setTimeout(r, 500));
        }

        // 3. Log
        await query(
          `INSERT INTO events (event_type, description, metadata)
           VALUES ('service_cut', $1, $2)`,
          [
            `Corte automático - cliente ${idServicio}`,
            JSON.stringify({ idServicio, phone, success: corteResult.success }),
          ]
        ).catch(() => {});

        cortados++;
        logger.info(`[SCHEDULER] Servicio cortado: cliente ${idServicio}`);

      } catch (err) {
        errores++;
        logger.error(`[SCHEDULER] Error al cortar servicio`, { error: err.message });
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    logger.info(`[SCHEDULER] Corte completado: ${cortados} cortados, ${errores} errores`);
    return { cortados, errores, total: facturas.length, skipped: false };

  } catch (err) {
    logger.error('[SCHEDULER] Error crítico en ejecutarCorteAutomatico', { error: err.message });
    return { cortados: 0, errores: 1, total: 0, skipped: false, error: err.message };
  }
};

// ─────────────────────────────────────────────────────────────
// JOB: Sincronizar contactos de WispHub a DB local
// ─────────────────────────────────────────────────────────────

const sincronizarClientes = async () => {
  logger.info('[SCHEDULER] Sincronizando contactos de WispHub...');
  try {
    const result = await wisphub.sincronizarContactos({ query });
    logger.info(`[SCHEDULER] Sync completo: ${result.total} total, ${result.created} nuevos, ${result.updated} actualizados`);
  } catch (err) {
    logger.error('[SCHEDULER] Error en sincronizarClientes', { error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// JOB: Limpiar pagos antiguos (> 6 meses)
// ─────────────────────────────────────────────────────────────

const limpiarPagosAntiguos = async () => {
  logger.info('[SCHEDULER] Limpiando pagos y eventos con más de 6 meses...');
  try {
    const res = await query(
      `DELETE FROM payments WHERE created_at < NOW() - INTERVAL '6 months'`
    );
    const borrados = res.rowCount || 0;
    if (borrados > 0) logger.info(`[SCHEDULER] Limpieza: ${borrados} pagos eliminados`);
  } catch (err) {
    logger.error('[SCHEDULER] Error en limpieza de pagos', { error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// INICIALIZAR TODOS LOS CRON JOBS
// ─────────────────────────────────────────────────────────────

const initScheduler = () => {
  logger.info('[SCHEDULER] Inicializando trabajos programados...');

  // ── Días 1-5: Avisos de cobro a las 8:00 AM hora Lima
  // NOTA: con timezone: 'America/Lima', el cron usa hora local Lima directamente
  cron.schedule('0 8 1-5 * *', async () => {
    logger.info('[CRON] Ejecutando: avisos de cobro días 1-5');
    await enviarAvisosCobro();
  }, {
    timezone: 'America/Lima',
  });

  // ── Día 10: Corte automático a las 9:00 AM Lima
  cron.schedule('0 9 10 * *', async () => {
    logger.info('[CRON] Ejecutando: corte automático día 10');
    await ejecutarCorteAutomatico();
  }, {
    timezone: 'America/Lima',
  });

  // ── Cada N minutos: Sincronizar contactos WispHub → DB local
  const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MINUTES || '5');
  cron.schedule(`*/${SYNC_INTERVAL} * * * *`, async () => {
    await sincronizarClientes();
  });

  // ── Cada día a las 3:00 AM Lima: Limpiar pagos con más de 6 meses
  cron.schedule('0 3 * * *', async () => {
    await limpiarPagosAntiguos();
  }, { timezone: 'America/Lima' });

  logger.info('[SCHEDULER] Trabajos programados activos:');
  logger.info('  Dias 1-5 a las 8:00 AM Lima → Avisos de cobro');
  logger.info('  Dia 10 a las 9:00 AM Lima  → Corte automatico');
  logger.info(`  Cada ${SYNC_INTERVAL} min           → Sincronizar contactos`);
  logger.info('  Cada dia a las 3:00 AM Lima → Limpieza pagos > 6 meses');
};

module.exports = {
  initScheduler,
  enviarAvisosCobro,
  ejecutarCorteAutomatico,
  sincronizarClientes,
  limpiarPagosAntiguos,
};
