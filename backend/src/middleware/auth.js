const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { error } = require('../utils/response');
const logger = require('../utils/logger');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return error(res, 'Token de autenticación requerido', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await query(
      'SELECT id, name, email, role, is_active FROM agents WHERE id = $1',
      [decoded.id]
    );

    if (!result.rows.length || !result.rows[0].is_active) {
      return error(res, 'Usuario no autorizado', 401);
    }

    req.agent = result.rows[0];
    next();
  } catch (err) {
    logger.warn('Auth failed', { error: err.message });
    if (err.name === 'TokenExpiredError') return error(res, 'Token expirado', 401);
    return error(res, 'Token inválido', 401);
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.agent?.role)) {
    return error(res, 'Permisos insuficientes', 403);
  }
  next();
};

module.exports = { authenticate, requireRole };
