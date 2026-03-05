-- ============================================================
-- MIGRATION 002: Message editing and soft delete
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_edited    BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS edited_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_deleted   BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;
