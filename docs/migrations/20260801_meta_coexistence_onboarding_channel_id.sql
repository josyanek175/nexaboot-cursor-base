-- =============================================================================
-- PROPOSTA — aditivo se a tabela onboarding já existir sem resulting_channel_id.
-- NÃO APLICAR automaticamente.
-- =============================================================================

BEGIN;

ALTER TABLE public.meta_coexistence_onboardings
  ADD COLUMN IF NOT EXISTS resulting_channel_id UUID;

COMMIT;
