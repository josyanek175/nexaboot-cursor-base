-- =============================================================================
-- PROPOSTA — NÃO APLICAR automaticamente.
-- Meta Coexistence: coluna aditiva meta_connection_mode (DEV only após aprovação).
-- =============================================================================
-- Pré-requisito: backup do schema DEV.
-- Rollback: ver 20260801_meta_connection_mode_rollback.sql

BEGIN;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS meta_connection_mode TEXT NOT NULL DEFAULT 'cloud_api';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_channels_meta_connection_mode_check'
  ) THEN
    ALTER TABLE public.whatsapp_channels
      ADD CONSTRAINT whatsapp_channels_meta_connection_mode_check
      CHECK (meta_connection_mode IN ('cloud_api', 'coexistence'));
  END IF;
END$$;

-- Colunas opcionais de onboarding Coexistence (nullable; não afetam cloud_api).
ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS embedded_signup_config_id TEXT;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS coexistence_status TEXT;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS history_sync_status TEXT;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS history_sync_started_at TIMESTAMPTZ;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS history_sync_completed_at TIMESTAMPTZ;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS webhook_subscription_status TEXT;

ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS app_business_id TEXT;

-- Backfill explícito (idempotente): Meta existente = cloud_api.
UPDATE public.whatsapp_channels
SET meta_connection_mode = 'cloud_api'
WHERE lower(channel_type) = 'meta'
  AND (meta_connection_mode IS NULL OR meta_connection_mode = 'cloud_api');

COMMIT;

-- Verificação sugerida (manual):
-- SELECT channel_type, meta_connection_mode, count(*) FROM whatsapp_channels GROUP BY 1,2;
