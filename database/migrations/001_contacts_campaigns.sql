-- ============================================================
-- MIGRATION 001: Contacts enrichment + Mass Campaigns
-- FiberPeru ISP
-- ============================================================

-- Extender tabla clients con campos enriquecidos de WispHub
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS service_status VARCHAR(50) DEFAULT 'activo',
  ADD COLUMN IF NOT EXISTS tags           TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS plan_price     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS fecha_registro TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wisphub_raw    JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_clients_service_status ON clients(service_status);

-- ============================================================
-- CAMPAÑAS MASIVAS
-- ============================================================
CREATE TABLE IF NOT EXISTS mass_campaigns (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  message         TEXT NOT NULL,
  status          VARCHAR(50) DEFAULT 'draft'
                  CHECK (status IN ('draft','running','completed','cancelled','failed')),
  total_recipients INTEGER DEFAULT 0,
  sent_count      INTEGER DEFAULT 0,
  delivered_count INTEGER DEFAULT 0,
  failed_count    INTEGER DEFAULT 0,
  created_by      UUID REFERENCES agents(id),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DESTINATARIOS DE CAMPAÑA
-- ============================================================
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id         UUID NOT NULL REFERENCES mass_campaigns(id) ON DELETE CASCADE,
  client_id           UUID REFERENCES clients(id),
  phone               VARCHAR(20) NOT NULL,
  name                VARCHAR(150),
  status              VARCHAR(50) DEFAULT 'pending'
                      CHECK (status IN ('pending','sent','delivered','failed')),
  sent_at             TIMESTAMPTZ,
  error_message       TEXT,
  whatsapp_message_id VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_camp_recipients_campaign ON campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_camp_recipients_status   ON campaign_recipients(status);

CREATE OR REPLACE TRIGGER mass_campaigns_updated_at
  BEFORE UPDATE ON mass_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
