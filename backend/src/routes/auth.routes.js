const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { login, me, changePassword } = require('../controllers/auth.controller');

router.post('/login', login);
router.get('/me', authenticate, me);
router.put('/change-password', authenticate, changePassword);

module.exports = router;
