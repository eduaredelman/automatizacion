require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

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
const contactRoutes     = require('./routes/contacts.routes');
const campaignRoutes    = require('./routes/campaigns.routes');
const botPaymentRoutes  = require('./routes/bot-payments.routes');
const auditRoutes       = require('./routes/audit.routes');

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
app.use('/api/bot-payments', botPaymentRoutes);
app.use('/api/audit',       auditRoutes);

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
    // Aplicar migraciones pendientes (SQL inline — no depende de archivos externos)
    const MIGRATIONS = [
      {
        name: '001_contacts_campaigns',
        sql: `
          CREATE TABLE IF NOT EXISTS clients (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            wisphub_id VARCHAR(50) UNIQUE,
            phone VARCHAR(20),
            name VARCHAR(150),
            email VARCHAR(150),
            service_id VARCHAR(50),
            plan VARCHAR(100),
            address TEXT,
            service_status VARCHAR(20) DEFAULT 'activo',
            tags TEXT[] DEFAULT '{}',
            plan_price NUMERIC(10,2),
            debt_amount NUMERIC(10,2),
            fecha_registro DATE,
            wisphub_raw JSONB,
            last_synced_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS quick_replies (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            title VARCHAR(100) NOT NULL,
            body TEXT NOT NULL,
            tags TEXT[] DEFAULT '{}',
            created_by UUID REFERENCES agents(id) ON DELETE SET NULL,
            is_global BOOLEAN DEFAULT true,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS mass_campaigns (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            name VARCHAR(150) NOT NULL,
            message TEXT NOT NULL,
            status VARCHAR(20) DEFAULT 'draft',
            created_by UUID REFERENCES agents(id) ON DELETE SET NULL,
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            total_recipients INT DEFAULT 0,
            sent_count INT DEFAULT 0,
            error_count INT DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS campaign_recipients (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            campaign_id UUID REFERENCES mass_campaigns(id) ON DELETE CASCADE,
            client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
            phone VARCHAR(20) NOT NULL,
            name VARCHAR(150),
            status VARCHAR(20) DEFAULT 'pending',
            sent_at TIMESTAMPTZ,
            error_message TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
          ALTER TABLE conversations ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;
          ALTER TABLE clients ADD COLUMN IF NOT EXISTS wisphub_raw JSONB;
          ALTER TABLE clients ADD COLUMN IF NOT EXISTS plan_price NUMERIC(10,2);
          ALTER TABLE clients ADD COLUMN IF NOT EXISTS fecha_registro DATE;
          CREATE INDEX IF NOT EXISTS idx_clients_wisphub_id ON clients(wisphub_id);
          CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
        `,
      },
      {
        name: '002_message_edit_softdelete',
        sql: `
          ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_edited  BOOLEAN     DEFAULT false;
          ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;
          ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN     DEFAULT false;
          ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        `,
      },
      {
        name: '003_wisphub_plans_nodo',
        sql: `
          CREATE TABLE IF NOT EXISTS wisphub_plans (
            id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            wisphub_plan_id  VARCHAR(50) UNIQUE NOT NULL,
            nombre           VARCHAR(150) NOT NULL,
            precio           NUMERIC(10,2) NOT NULL DEFAULT 0,
            velocidad_bajada VARCHAR(30),
            velocidad_subida VARCHAR(30),
            activo           BOOLEAN DEFAULT true,
            wisphub_raw      JSONB,
            last_synced_at   TIMESTAMPTZ,
            created_at       TIMESTAMPTZ DEFAULT NOW(),
            updated_at       TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_wisphub_plans_id ON wisphub_plans(wisphub_plan_id);
          ALTER TABLE clients ADD COLUMN IF NOT EXISTS wisphub_plan_id VARCHAR(50);
          ALTER TABLE clients ADD COLUMN IF NOT EXISTS nodo            VARCHAR(100);
          CREATE INDEX IF NOT EXISTS idx_clients_wisphub_plan_id ON clients(wisphub_plan_id);
        `,
      },
    ];
    for (const m of MIGRATIONS) {
      try {
        await query(m.sql);
        logger.info(`✅ Migration ${m.name} applied`);
      } catch (err) {
        logger.warn(`Migration ${m.name} warning:`, err.message);
      }
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
