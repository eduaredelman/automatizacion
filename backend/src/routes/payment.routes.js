const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { listPayments, getStats, getPayment, validatePayment, rejectPayment } = require('../controllers/payment.controller');

router.use(authenticate);

router.get('/stats', getStats);
router.get('/', listPayments);
router.get('/:id', getPayment);
router.patch('/:id/validate', validatePayment);
router.patch('/:id/reject', rejectPayment);

module.exports = router;
