const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { listBotPayments, reconcilePayments } = require('../controllers/bot-payments.controller');

router.use(authenticate);
router.get('/', listBotPayments);
router.post('/reconcile', reconcilePayments);

module.exports = router;
