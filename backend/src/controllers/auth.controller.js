const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { success, error } = require('../utils/response');
const logger = require('../utils/logger');

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return error(res, 'Email y contraseña requeridos', 400);

    const result = await query(
      'SELECT * FROM agents WHERE email = $1 AND is_active = true',
      [email.toLowerCase().trim()]
    );

    if (!result.rows.length) return error(res, 'Credenciales inválidas', 401);

    const agent = result.rows[0];
    const validPassword = await bcrypt.compare(password, agent.password);
    if (!validPassword) return error(res, 'Credenciales inválidas', 401);

    // Update last login
    await query('UPDATE agents SET last_login = NOW() WHERE id = $1', [agent.id]);

    const token = jwt.sign(
      { id: agent.id, email: agent.email, role: agent.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    logger.info('Agent logged in', { email: agent.email, role: agent.role });

    return success(res, {
      token,
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        role: agent.role,
        avatar_url: agent.avatar_url,
      },
    }, 'Login exitoso');
  } catch (err) {
    logger.error('Login error', { error: err.message });
    return error(res, 'Error en el servidor');
  }
};

const me = async (req, res) => {
  return success(res, req.agent);
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return error(res, 'Contraseñas requeridas', 400);
    if (newPassword.length < 8) return error(res, 'La contraseña debe tener al menos 8 caracteres', 400);

    const result = await query('SELECT password FROM agents WHERE id = $1', [req.agent.id]);
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password);
    if (!valid) return error(res, 'Contraseña actual incorrecta', 401);

    const hashed = await bcrypt.hash(newPassword, 12);
    await query('UPDATE agents SET password = $1 WHERE id = $2', [hashed, req.agent.id]);

    return success(res, {}, 'Contraseña actualizada');
  } catch (err) {
    return error(res, 'Error al cambiar contraseña');
  }
};

module.exports = { login, me, changePassword };
