-- Heartbeats de workers dedicados (media, futuro media/campaign…).
-- Permite ao /api/health do web ler last_seen sem fingir connected=true.
-- Aplicação: manual. Rollback: 20260809_webhook_worker_heartbeats_rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS public.webhook_worker_heartbeats (
  worker_kind TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  connected BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_worker_heartbeats_seen
  ON public.webhook_worker_heartbeats (last_seen_at DESC);

COMMIT;
