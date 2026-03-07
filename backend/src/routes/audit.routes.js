const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  auditByPhone,
  auditByName,
  auditConversation,
  fixClientLink,
  dbSummary,
} = require('../controllers/audit.controller');

// Todas las rutas requieren autenticación JWT
router.use(authenticate);

router.get('/client',           auditByPhone);       // ?phone=51XXXXXXXXX
router.get('/client-name',      auditByName);         // ?name=Marcela
router.get('/conversation',     auditConversation);   // ?id=UUID
router.get('/db-summary',       dbSummary);
router.post('/fix-client',      fixClientLink);       // ?phone=51XXXXXXXXX

module.exports = router;
