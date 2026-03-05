const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  listChats, getChat, sendMessage, sendMedia, startNewChat,
  takeover, release, getPayments, resolve, updateName,
  archiveChat, getQuickReplies, createQuickReply, deleteQuickReply, deleteMessage, editMessage
} = require('../controllers/chat.controller');

// Multer: memoria, 25 MB, tipos permitidos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf',
      'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/wav',
      // Word
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      // Excel
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // PowerPoint
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.use(authenticate);

// IMPORTANTE: rutas estáticas ANTES de /:id para evitar conflictos de parámetros
router.get('/quick-replies', getQuickReplies);
router.post('/quick-replies', createQuickReply);
router.delete('/quick-replies/:id', deleteQuickReply);
router.post('/start', startNewChat);

router.get('/', listChats);
router.get('/:id', getChat);
router.post('/:id/send', sendMessage);
router.post('/:id/send-media', upload.single('file'), sendMedia);
router.post('/:id/takeover', takeover);
router.post('/:id/release', release);
router.post('/:id/resolve', resolve);
router.patch('/:id/name', updateName);
router.patch('/:id/messages/:msgId', editMessage);
router.delete('/:id/messages/:msgId', deleteMessage);
router.delete('/:id', archiveChat);
router.get('/:id/payments', getPayments);

module.exports = router;
