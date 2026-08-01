-- =============================================================================
-- PROPOSTA — NÃO APLICAR automaticamente.
-- Onboarding temporário Meta Coexistence (code trocado 1x; token cifrado).
-- =============================================================================
-- Pré-requisito: META_TOKEN_ENCRYPTION_KEY no app; backup DEV.
-- Rollback: 20260801_meta_coexistence_onboarding_rollback.sql
-- Só é usada quando META_COEXISTENCE_ENABLED=true.

BEGIN;

CREATE TABLE IF NOT EXISTS public.meta_coexistence_csrf_states (
  state TEXT PRIMARY KEY,
  company_id UUID NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_meta_coex_csrf_expires
  ON public.meta_coexistence_csrf_states (expires_at);

CREATE TABLE IF NOT EXISTS public.meta_coexistence_onboardings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  user_id UUID NOT NULL,
  -- Token SEMPRE cifrado (AES-GCM via META_TOKEN_ENCRYPTION_KEY). Nunca plaintext.
  access_token_ciphertext TEXT,
  token_expires_at TIMESTAMPTZ,
  waba_id TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  business_id TEXT,
  display_phone_number TEXT,
  -- Preenchido no commit do /connect (idempotência de replay).
  resulting_channel_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_meta_coex_onboarding_expires
  ON public.meta_coexistence_onboardings (expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_meta_coex_onboarding_company
  ON public.meta_coexistence_onboardings (company_id, created_at DESC);

COMMIT;
