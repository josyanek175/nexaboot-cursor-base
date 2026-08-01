-- =============================================================================
-- ROLLBACK — Meta Coexistence meta_connection_mode (somente DEV, após aprovação).
-- ATENÇÃO: remove colunas Coexistence. Não executar em produção sem plano.
-- =============================================================================

BEGIN;

ALTER TABLE public.whatsapp_channels
  DROP CONSTRAINT IF EXISTS whatsapp_channels_meta_connection_mode_check;

ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS meta_connection_mode;
ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS token_expires_at;
ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS embedded_signup_config_id;
ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS coexistence_status;
ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS onboarding_completed_at;
ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS history_sync_status;
ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS history_sync_started_at;
ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS history_sync_completed_at;
ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS webhook_subscription_status;
ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS app_business_id;

COMMIT;
