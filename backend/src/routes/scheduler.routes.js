const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const {
  enviarAvisosCobro,
  ejecutarCorteAutomatico,
  sincronizarClientes,
} = require('../services/scheduler.service');
const { success, error } = require('../utils/response');
const logger = require('../utils/logger');

// Solo admins pueden ejecutar trabajos manualmente
router.use(authenticate, requireRole('admin'));

// POST /api/scheduler/run/cobro - Ejecutar avisos de cobro manualmente
router.post('/run/cobro', async (req, res) => {
  try {
    // Responder inmediato y correr en background
    success(res, {}, 'Avisos de cobro iniciados en background');
    await enviarAvisosCobro();
  } catch (err) {
    logger.error('Manual cobro run failed', { error: err.message });
  }
});

// POST /api/scheduler/run/corte - Ejecutar corte manualmente
router.post('/run/corte', async (req, res) => {
  try {
    success(res, {}, 'Corte automático iniciado en background');
    await ejecutarCorteAutomatico();
  } catch (err) {
    logger.error('Manual corte run failed', { error: err.message });
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

// GET /api/scheduler/status - Ver próximos trabajos
router.get('/status', (req, res) => {
  const now = new Date();
  const dia = now.getDate();

  return success(res, {
    current_day: dia,
    jobs: [
      {
        name: 'Avisos de cobro',
        schedule: 'Días 1-5 a las 8:00 AM',
        active_today: dia >= 1 && dia <= 5,
        description: 'Envía recordatorio de pago a todos los clientes con deuda pendiente',
      },
      {
        name: 'Corte automático',
        schedule: 'Día 10 a las 9:00 AM',
        active_today: dia === 10,
        description: 'Suspende el servicio de clientes que no han pagado',
      },
      {
        name: 'Sincronización WispHub',
        schedule: 'Diario a las 7:00 AM',
        active_today: true,
        description: 'Actualiza la base de datos local con los clientes de WispHub',
      },
    ],
  });
});

module.exports = router;
