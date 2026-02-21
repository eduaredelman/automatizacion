const express = require('express');
const router = express.Router();
const { verify, receive } = require('../controllers/webhook.controller');
const { verifyWhatsAppSignature } = require('../middleware/webhook');

router.get('/', verify);
router.post('/', verifyWhatsAppSignature, receive);

module.exports = router;
