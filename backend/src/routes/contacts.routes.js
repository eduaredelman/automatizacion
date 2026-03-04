const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  getContacts, syncContacts, getSyncStatus, sendMessage, debugWisphub, debugDb,
} = require('../controllers/contacts.controller');

router.use(authenticate);

// Rutas estáticas primero
router.get('/sync/status',          getSyncStatus);
router.post('/sync',                syncContacts);
router.get('/debug/wisphub',        debugWisphub);
router.get('/debug/db',             debugDb);

router.get('/',                     getContacts);
router.post('/:wisphub_id/message', sendMessage);

module.exports = router;
