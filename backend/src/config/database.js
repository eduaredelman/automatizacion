const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' && process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error', { error: err.message });
});

const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    logger.debug('DB query', { duration: Date.now() - start, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('DB query error', { error: err.message, query: text });
    throw err;
  }
};

const getClient = () => pool.connect();

const checkConnection = async () => {
  try { await pool.query('SELECT 1'); return true; } catch { return false; }
};

module.exports = { query, getClient, pool, checkConnection };
