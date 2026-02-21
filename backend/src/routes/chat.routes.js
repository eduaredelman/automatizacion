const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  listChats, getChat, sendMessage, takeover, release, getPayments, resolve
} = require('../controllers/chat.controller');

router.use(authenticate);

router.get('/', listChats);
router.get('/:id', getChat);
router.post('/:id/send', sendMessage);
router.post('/:id/takeover', takeover);
router.post('/:id/release', release);
router.post('/:id/resolve', resolve);
router.get('/:id/payments', getPayments);

module.exports = router;
