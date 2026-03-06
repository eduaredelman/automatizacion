const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { listBotPayments } = require('../controllers/bot-payments.controller');

router.use(authenticate);
router.get('/', listBotPayments);

module.exports = router;
