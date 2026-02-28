const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  listChats, getChat, sendMessage, takeover, release, getPayments, resolve, updateName,
  archiveChat, getQuickReplies, createQuickReply, deleteQuickReply
} = require('../controllers/chat.controller');

router.use(authenticate);

// IMPORTANTE: rutas estáticas ANTES de /:id para evitar conflictos de parámetros
router.get('/quick-replies', getQuickReplies);
router.post('/quick-replies', createQuickReply);
router.delete('/quick-replies/:id', deleteQuickReply);

router.get('/', listChats);
router.get('/:id', getChat);
router.post('/:id/send', sendMessage);
router.post('/:id/takeover', takeover);
router.post('/:id/release', release);
router.post('/:id/resolve', resolve);
router.patch('/:id/name', updateName);
router.delete('/:id', archiveChat);
router.get('/:id/payments', getPayments);

module.exports = router;
