-- =============================================================================
-- Inbox durável de webhooks — ETAPA 1 (somente ingestão).
-- =============================================================================
-- Objetivo: persistir o payload bruto do webhook ANTES de qualquer
-- processamento, para que o HTTP 200 só seja devolvido depois do COMMIT.
--
-- Aplicação: manual (não é criada pelo bootstrap de schema).
-- Rollback:  20260808_webhook_inbox_rollback.sql
--
-- Precondição operacional: aplicar esta migration ANTES de ligar
-- WEBHOOK_DURABLE_INBOX_ENABLED=true. Com a flag ligada e a tabela ausente,
-- a ingestão responde 503 (nunca 200 sem persistência).
--
-- Sem FOREIGN KEY para companies/whatsapp_channels de propósito: a ingestão
-- não resolve canal/empresa (isso é trabalho do worker da etapa 2) e uma FK
-- transformaria evento de canal desconhecido em falha de persistência.
--
-- O payload NUNCA é apagado automaticamente. Retenção é decisão operacional.

BEGIN;

CREATE TABLE IF NOT EXISTS public.webhook_inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_type TEXT,
  company_id UUID,
  channel_id UUID,
  instance_name TEXT,
  external_event_id TEXT,
  external_message_id TEXT,
  deduplication_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  request_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_inbox_status_check
    CHECK (status IN ('pending', 'processing', 'retry', 'processed', 'dead_letter'))
);

-- Idempotência da ingestão: reentrega do mesmo evento não cria segunda linha.
CREATE UNIQUE INDEX IF NOT EXISTS ux_webhook_inbox_provider_dedup
  ON public.webhook_inbox (provider, deduplication_key);

-- Fila de trabalho do worker (etapa 2): só o que está elegível.
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_claim
  ON public.webhook_inbox (available_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_company
  ON public.webhook_inbox (company_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_channel
  ON public.webhook_inbox (channel_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_received_at
  ON public.webhook_inbox (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_external_message_id
  ON public.webhook_inbox (external_message_id)
  WHERE external_message_id IS NOT NULL;

COMMIT;
