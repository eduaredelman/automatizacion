const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  listBotPayments, reconcilePayments,
  listClientesMes, sendMensajeDeudores,
  getMatrizPagos, getHistorialCliente,
} = require('../controllers/bot-payments.controller');

router.use(authenticate);
router.get('/',                   listBotPayments);
router.post('/reconcile',         reconcilePayments);
router.get('/clientes-mes',       listClientesMes);
router.post('/send-deudores',     sendMensajeDeudores);
router.get('/matriz',             getMatrizPagos);
router.get('/historial/:clientId', getHistorialCliente);

module.exports = router;
