const express = require('express');
const router  = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const {
  enviarAvisosCobro,
  ejecutarCorteAutomatico,
  sincronizarClientes,
} = require('../services/scheduler.service');
const { query }        = require('../config/database');
const { success, error } = require('../utils/response');
const logger           = require('../utils/logger');

// Solo admins pueden ejecutar trabajos manualmente
router.use(authenticate, requireRole('admin'));

// POST /api/scheduler/run/cobro - Ejecutar avisos de cobro manualmente
router.post('/run/cobro', async (req, res) => {
  try {
    // force=true: omite el chequeo de días 1-5 para permitir prueba en cualquier día
    const result = await enviarAvisosCobro({ force: true });
    return success(res, result, 'Avisos de cobro ejecutados');
  } catch (err) {
    logger.error('Manual cobro run failed', { error: err.message });
    return error(res, 'Error al ejecutar avisos de cobro');
  }
});

// POST /api/scheduler/run/corte - Ejecutar corte manualmente
router.post('/run/corte', async (req, res) => {
  try {
    const result = await ejecutarCorteAutomatico({ force: true });
    return success(res, result, 'Corte automático ejecutado');
  } catch (err) {
    logger.error('Manual corte run failed', { error: err.message });
    return error(res, 'Error al ejecutar corte automático');
  }
});

// POST /api/scheduler/run/sync - Sincronizar clientes manualmente
router.post('/run/sync', async (req, res) => {
  try {
    success(res, {}, 'Sincronización iniciada en background');
    await sincronizarClientes();
  } catch (err) {
    logger.error('Manual sync failed', { error: err.message });
  }
});

// GET /api/scheduler/status - Estado actual + últimas ejecuciones
router.get('/status', async (req, res) => {
  const now = new Date();
  const dia = now.getDate();

  // Últimas ejecuciones de cobro y corte desde la tabla events
  let lastCobro = null;
  let lastCorte = null;
  let cobroCount = 0;
  let corteCount = 0;

  try {
    const cobroRes = await query(
      `SELECT created_at, metadata
       FROM events
       WHERE event_type = 'payment_reminder_sent'
       ORDER BY created_at DESC LIMIT 1`
    );
    if (cobroRes.rows.length) {
      lastCobro  = cobroRes.rows[0].created_at;
      const meta = cobroRes.rows[0].metadata || {};
      cobroCount = meta.dia ? 1 : 0;
    }

    // Contar cuántos avisos se enviaron HOY
    const cobroHoyRes = await query(
      `SELECT COUNT(*) FROM events
       WHERE event_type = 'payment_reminder_sent'
         AND created_at >= CURRENT_DATE`
    );
    cobroCount = parseInt(cobroHoyRes.rows[0].count);

    const corteRes = await query(
      `SELECT created_at FROM events
       WHERE event_type = 'service_cut'
       ORDER BY created_at DESC LIMIT 1`
    );
    if (corteRes.rows.length) lastCorte = corteRes.rows[0].created_at;

    // Contar cortes del mes actual
    const corteCountRes = await query(
      `SELECT COUNT(*) FROM events
       WHERE event_type = 'service_cut'
         AND created_at >= date_trunc('month', NOW())`
    );
    corteCount = parseInt(corteCountRes.rows[0].count);
  } catch (err) {
    logger.warn('Error fetching scheduler stats', { error: err.message });
  }

  return success(res, {
    current_day: dia,
    stats: {
      cobro_sent_today: cobroCount,
      corte_this_month: corteCount,
      last_cobro_at: lastCobro,
      last_corte_at: lastCorte,
    },
    jobs: [
      {
        name:         'Avisos de cobro',
        schedule:     'Días 1-5 a las 8:00 AM',
        active_today: dia >= 1 && dia <= 5,
        description:  'Envía recordatorio de pago a todos los clientes con deuda pendiente',
      },
      {
        name:         'Corte automático',
        schedule:     'Día 10 a las 9:00 AM',
        active_today: dia === 10,
        description:  'Suspende el servicio de clientes que no han pagado',
      },
      {
        name:         'Sincronización WispHub',
        schedule:     `Cada ${process.env.SYNC_INTERVAL_MINUTES || 5} minutos`,
        active_today: true,
        description:  'Actualiza la base de datos local con todos los contactos de WispHub',
      },
    ],
  });
});

module.exports = router;
