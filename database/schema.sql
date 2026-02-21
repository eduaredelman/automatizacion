-- ============================================================
-- WHATSAPP PAYMENT AUTOMATION PLATFORM - PostgreSQL Schema
-- FiberPeru ISP - v2.0
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- AGENTS (human support staff)
-- ============================================================
CREATE TABLE agents (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(100) NOT NULL,
    email       VARCHAR(150) UNIQUE NOT NULL,
    password    VARCHAR(255) NOT NULL,
    role        VARCHAR(20) NOT NULL DEFAULT 'agent' CHECK (role IN ('admin','agent','viewer')),
    avatar_url  TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    last_login  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CLIENTS (cached from WispHub)
-- ============================================================
CREATE TABLE clients (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wisphub_id      VARCHAR(50) UNIQUE,
    phone           VARCHAR(20) NOT NULL,
    name            VARCHAR(150),
    email           VARCHAR(150),
    service_id      VARCHAR(50),
    plan            VARCHAR(100),
    address         TEXT,
    debt_amount     NUMERIC(10,2) DEFAULT 0,
    last_synced_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_clients_phone ON clients(phone);
CREATE INDEX idx_clients_wisphub_id ON clients(wisphub_id);

-- ============================================================
-- CONVERSATIONS (one per phone number)
-- ============================================================
CREATE TABLE conversations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID REFERENCES clients(id) ON DELETE SET NULL,
    phone           VARCHAR(20) NOT NULL UNIQUE,
    display_name    VARCHAR(150),
    status          VARCHAR(20) NOT NULL DEFAULT 'bot'
                    CHECK (status IN ('bot','human','resolved','spam')),
    assigned_to     UUID REFERENCES agents(id) ON DELETE SET NULL,
    last_message    TEXT,
    last_message_at TIMESTAMPTZ,
    unread_count    INTEGER NOT NULL DEFAULT 0,
    bot_intent      VARCHAR(50),  -- 'payment','support','complaint','sales','unknown'
    is_archived     BOOLEAN NOT NULL DEFAULT false,
    tags            TEXT[] DEFAULT '{}',
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversations_phone ON conversations(phone);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_conversations_assigned_to ON conversations(assigned_to);
CREATE INDEX idx_conversations_last_message_at ON conversations(last_message_at DESC);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    whatsapp_id     VARCHAR(100) UNIQUE,  -- Meta message ID
    direction       VARCHAR(10) NOT NULL CHECK (direction IN ('inbound','outbound')),
    sender_type     VARCHAR(10) NOT NULL CHECK (sender_type IN ('client','bot','agent','system')),
    agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
    message_type    VARCHAR(20) NOT NULL DEFAULT 'text'
                    CHECK (message_type IN ('text','image','audio','video','document','location','sticker','reaction','system')),
    body            TEXT,
    media_url       TEXT,    -- stored path or URL
    media_mime      VARCHAR(50),
    media_filename  VARCHAR(255),
    media_size      INTEGER,
    whatsapp_status VARCHAR(20) DEFAULT 'sent'
                    CHECK (whatsapp_status IN ('pending','sent','delivered','read','failed')),
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX idx_messages_whatsapp_id ON messages(whatsapp_id);
CREATE INDEX idx_messages_message_type ON messages(message_type);

-- ============================================================
-- PAYMENTS (vouchers/comprobantes)
-- ============================================================
CREATE TABLE payments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id     UUID REFERENCES conversations(id) ON DELETE SET NULL,
    message_id          UUID REFERENCES messages(id) ON DELETE SET NULL,
    client_id           UUID REFERENCES clients(id) ON DELETE SET NULL,
    wisphub_payment_id  VARCHAR(50),
    factura_id          VARCHAR(50),
    -- OCR extracted data
    payment_method      VARCHAR(50),  -- 'yape','plin','bcp','interbank','bbva','scotiabank','transfer'
    amount              NUMERIC(10,2),
    currency            VARCHAR(5) DEFAULT 'PEN',
    operation_code      VARCHAR(100) UNIQUE,
    payment_date        DATE,
    payment_time        TIME,
    payer_name          VARCHAR(150),
    payer_phone         VARCHAR(20),
    card_last4          VARCHAR(4),
    -- File
    voucher_path        TEXT,
    voucher_url         TEXT,
    -- Validation
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','validated','rejected','duplicate','manual_review')),
    ocr_confidence      VARCHAR(10) CHECK (ocr_confidence IN ('high','medium','low','none')),
    ocr_raw             JSONB DEFAULT '{}',
    rejection_reason    TEXT,
    validated_by        UUID REFERENCES agents(id) ON DELETE SET NULL,
    validated_at        TIMESTAMPTZ,
    registered_wisphub  BOOLEAN NOT NULL DEFAULT false,
    -- Metadata
    debt_amount         NUMERIC(10,2),
    amount_difference   NUMERIC(10,2),
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_conversation_id ON payments(conversation_id);
CREATE INDEX idx_payments_client_id ON payments(client_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_operation_code ON payments(operation_code);
CREATE INDEX idx_payments_created_at ON payments(created_at DESC);
CREATE INDEX idx_payments_payment_method ON payments(payment_method);

-- ============================================================
-- EVENTS / AUDIT LOG
-- ============================================================
CREATE TABLE events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    payment_id      UUID REFERENCES payments(id) ON DELETE SET NULL,
    agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
    event_type      VARCHAR(50) NOT NULL,
    description     TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_conversation_id ON events(conversation_id);
CREATE INDEX idx_events_event_type ON events(event_type);
CREATE INDEX idx_events_created_at ON events(created_at DESC);

-- ============================================================
-- TAKEOVER SESSIONS
-- ============================================================
CREATE TABLE takeover_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    reason          TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_takeover_conversation_id ON takeover_sessions(conversation_id);
CREATE INDEX idx_takeover_agent_id ON takeover_sessions(agent_id);
CREATE INDEX idx_takeover_is_active ON takeover_sessions(is_active);

-- ============================================================
-- QUICK REPLIES (templates for agents)
-- ============================================================
CREATE TABLE quick_replies (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title       VARCHAR(100) NOT NULL,
    body        TEXT NOT NULL,
    tags        TEXT[] DEFAULT '{}',
    created_by  UUID REFERENCES agents(id) ON DELETE SET NULL,
    is_global   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TRIGGERS: updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SEED: Initial admin agent
-- password = 'Admin2024!' (bcrypt hashed)
-- ============================================================
INSERT INTO agents (name, email, password, role) VALUES
('Administrador', 'admin@fiberperu.com', '$2a$12$unVEy4SDZLl3NkZZEgtGQOnxgrw5vgHNeVKetBIkM.AR5zyg.V8L.', 'admin');

-- Quick replies seed
INSERT INTO quick_replies (title, body, is_global) VALUES
('Bienvenida', 'Hola 👋 Bienvenido a FiberPeru. ¿En qué puedo ayudarte hoy?', true),
('Pago registrado', '✅ Tu pago ha sido registrado correctamente. Tu servicio será reactivado en los próximos minutos.', true),
('Solicitar voucher', 'Por favor envíanos la foto de tu comprobante de pago (Yape, Plin, transferencia bancaria) para registrarlo.', true),
('Soporte técnico', 'Te contactaremos dentro de 30 minutos para dar solución a tu problema. Gracias por tu paciencia. 🙏', true),
('Cierre conversación', 'Fue un placer atenderte. Si necesitas más ayuda, no dudes en escribirnos. ¡Hasta luego! 😊', true);
