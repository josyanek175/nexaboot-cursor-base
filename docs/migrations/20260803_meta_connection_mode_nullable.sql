-- =============================================================================
-- Meta Coexistence: meta_connection_mode nullable (PRODUÇÃO / ambientes novos).
-- NÃO usar 20260801_meta_connection_mode.sql em produção (NOT NULL DEFAULT
-- forçava cloud_api também em canais Evolution).
-- =============================================================================
-- Comportamento:
--   - canais Meta → meta_connection_mode = 'cloud_api' (quando NULL ou já cloud_api);
--   - canais não Meta com valor legado 'cloud_api' → NULL
--     (não altera outros valores futuros, ex. typos ou modos novos);
--   - CHECK permite NULL | cloud_api | coexistence;
--   - não altera status, active, tokens, webhooks ou conexões.
-- Rollback (manual, só com autorização): ver comentários ao final.
-- =============================================================================

BEGIN;

-- Coluna nullable, sem DEFAULT (não atribui cloud_api a Evolution).
ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS meta_connection_mode TEXT;

-- Remover DEFAULT / NOT NULL se a coluna veio da migration antiga.
-- Sem EXCEPTION: qualquer falha aborta e reverte a transação.
ALTER TABLE public.whatsapp_channels
  ALTER COLUMN meta_connection_mode DROP DEFAULT;

ALTER TABLE public.whatsapp_channels
  ALTER COLUMN meta_connection_mode DROP NOT NULL;

ALTER TABLE public.whatsapp_channels
  DROP CONSTRAINT IF EXISTS whatsapp_channels_meta_connection_mode_check;

ALTER TABLE public.whatsapp_channels
  ADD CONSTRAINT whatsapp_channels_meta_connection_mode_check
  CHECK (
    meta_connection_mode IS NULL
    OR meta_connection_mode IN ('cloud_api', 'coexistence')
  );

-- Meta existentes → cloud_api (preserva coexistence se já setado).
UPDATE public.whatsapp_channels
SET meta_connection_mode = 'cloud_api'
WHERE lower(channel_type) = 'meta'
  AND (
    meta_connection_mode IS NULL
    OR meta_connection_mode = 'cloud_api'
  );

-- Não-Meta: limpar somente o default legado 'cloud_api'.
UPDATE public.whatsapp_channels
SET meta_connection_mode = NULL
WHERE lower(channel_type) IS DISTINCT FROM 'meta'
  AND meta_connection_mode = 'cloud_api';

-- Colunas aditivas de onboarding Coexistence (nullable; não afetam Evolution/conexões).
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

COMMIT;

-- Verificações sugeridas (manual):
-- SELECT channel_type, meta_connection_mode, count(*) FROM public.whatsapp_channels GROUP BY 1,2;
-- SELECT is_nullable, column_default FROM information_schema.columns
--   WHERE table_name='whatsapp_channels' AND column_name='meta_connection_mode';
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname='whatsapp_channels_meta_connection_mode_check';
--
-- Rollback manual (NÃO executar sem autorização; destrutivo em colunas):
--   ALTER TABLE ... DROP CONSTRAINT IF EXISTS whatsapp_channels_meta_connection_mode_check;
--   ALTER TABLE ... DROP COLUMN IF EXISTS meta_connection_mode;
--   (+ demais colunas aditivas desta migration, se necessário)
