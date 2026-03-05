require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const fs     = require('fs');
const logger = require('./utils/logger');
const { query, checkConnection } = require('./config/database');
const { initSocket } = require('./config/socket');
const { initScheduler } = require('./services/scheduler.service');

// Routes
const webhookRoutes  = require('./routes/webhook.routes');
const chatRoutes     = require('./routes/chat.routes');
const authRoutes     = require('./routes/auth.routes');
const paymentRoutes  = require('./routes/payment.routes');
const schedulerRoutes = require('./routes/scheduler.routes');
const contactRoutes  = require('./routes/contacts.routes');
const campaignRoutes = require('./routes/campaigns.routes');

const app = express();
const server = http.createServer(app);

// Trust proxy (NPM / nginx en frente)
app.set('trust proxy', 1);

// ── Socket.IO ──────────────────────────────────────────────
initSocket(server);

// ── Security ───────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: (process.env.FRONTEND_URL || 'http://localhost:3000').split(','),
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Webhook gets a more permissive rate limit
const webhookLimiter = rateLimit({
  windowMs: 60000,
  max: 500,
  skipSuccessfulRequests: false,
});
app.use('/webhook', webhookLimiter);

// ── Body Parsing ───────────────────────────────────────────
// Webhook: capturar raw body para verificación de firma Meta
app.use('/webhook', express.raw({ type: '*/*', limit: '10mb' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body.toString('utf8');
    try { req.body = JSON.parse(req.rawBody); } catch { req.body = {}; }
  }
  next();
});

// Resto de rutas usan JSON normal
app.use((req, res, next) => {
  if (req.path.startsWith('/webhook')) return next();
  express.json({ limit: '10mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

// ── Logging ────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
  skip: (req) => req.path === '/health',
}));

// ── Static files (uploaded vouchers) ──────────────────────
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');
app.use('/uploads', express.static(uploadsDir, {
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// ── Routes ─────────────────────────────────────────────────
app.use('/webhook', webhookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/scheduler', schedulerRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/campaigns', campaignRoutes);

// ── Health Check ───────────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbOk = await checkConnection();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'healthy' : 'degraded',
    service: 'whatsapp-payment-backend',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    components: { database: dbOk ? 'up' : 'down' },
  });
});

// ── 404 ────────────────────────────────────────────────────
app.use((req, res) => {
  // Dejar pasar rutas de Socket.IO (el listener de socket.io corre sobre el mismo httpServer)
  if (req.path.startsWith('/socket.io')) return;
  res.status(404).json({ success: false, message: 'Ruta no encontrada' });
});

// ── Global Error Handler ───────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, message: 'Error interno del servidor' });
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

server.listen(PORT, async () => {
  logger.info(`🚀 Backend server running on port ${PORT}`);
  logger.info(`   Environment: ${process.env.NODE_ENV || 'development'}`);

  const dbOk = await checkConnection();
  if (dbOk) {
    logger.info('✅ PostgreSQL connected');
    // Aplicar migraciones pendientes
    try {
      const migrationPath = path.join(__dirname, '../../database/migrations/001_contacts_campaigns.sql');
      if (fs.existsSync(migrationPath)) {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        await query(sql);
        logger.info('✅ Migration 001_contacts_campaigns applied');
      }
    } catch (err) {
      // Las migraciones idempotentes (IF NOT EXISTS / IF EXISTS) no fallan en re-ejecución
      logger.warn('Migration warning (may already be applied):', err.message);
    }
    try {
      const migration002 = path.join(__dirname, '../../database/migrations/002_message_edit_softdelete.sql');
      if (fs.existsSync(migration002)) {
        const sql = fs.readFileSync(migration002, 'utf8');
        await query(sql);
        logger.info('✅ Migration 002_message_edit_softdelete applied');
      }
    } catch (err) {
      logger.warn('Migration 002 warning (may already be applied):', err.message);
    }
    // Iniciar scheduler DESPUÉS de confirmar que la DB está lista
    initScheduler();
  } else {
    logger.error('❌ PostgreSQL connection failed - check DATABASE_URL');
  }
});

// Graceful shutdown
const gracefulShutdown = () => {
  logger.info('Shutting down gracefully...');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

module.exports = { app, server };
