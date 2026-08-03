-- =============================================================================
-- PROPOSTA — NÃO APLICAR automaticamente (somente DEV após aprovação).
-- Campos aditivos para Embedded Signup / coexistence.
-- Pré-requisito: 20260801_meta_connection_mode.sql (meta_connection_mode etc.).
-- =============================================================================
-- connection_mode no código/API = coluna meta_connection_mode (não duplicar).
-- Rollback: DROP COLUMN connected_at, webhook_subscribed_at.

BEGIN;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS webhook_subscribed_at TIMESTAMPTZ;

-- Backfill: canais coexistence já conectados.
UPDATE public.whatsapp_channels
SET connected_at = COALESCE(connected_at, onboarding_completed_at, updated_at)
WHERE lower(channel_type) = 'meta'
  AND meta_connection_mode = 'coexistence'
  AND connected_at IS NULL;

COMMIT;
