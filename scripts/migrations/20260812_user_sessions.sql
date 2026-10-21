-- Migration: sessões server-side (Fase 1).
-- Aplicar MANUALMENTE em DEV/PROD antes ou junto do deploy.
-- Idempotente. Não remove dados. Não altera sessões stateless (cookies antigos
-- passam a ser inválidos — re-login único esperado).

CREATE TABLE IF NOT EXISTS public.user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id UUID NULL REFERENCES public.companies(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NULL,
  ip INET NULL,
  user_agent TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash
  ON public.user_sessions (token_hash);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id
  ON public.user_sessions (user_id);

-- No máximo UMA sessão ativa por usuário.
CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_one_active_per_user
  ON public.user_sessions (user_id)
  WHERE revoked_at IS NULL;
