-- =============================================================================
-- Outbox transacional de webhooks — ETAPA 2 (publicação no RabbitMQ).
-- =============================================================================
-- Cada evento novo grava inbox + outbox na MESMA transação. Só depois do COMMIT
-- dos dois registros o endpoint responde HTTP 200. Assim a publicação no
-- RabbitMQ deixa de ser um ponto de perda: se o broker estiver fora, o evento
-- continua preservado aqui até ser publicado.
--
-- Aplicação: manual, DEPOIS de 20260808_webhook_inbox.sql (existe FK para ela).
-- Rollback:  20260808_webhook_outbox_rollback.sql
--
-- Precondição operacional: aplicar esta migration ANTES de subir o código da
-- etapa 2 com WEBHOOK_DURABLE_INBOX_ENABLED=true. Com a flag ligada e esta
-- tabela ausente, a transação inteira falha e a ingestão responde 503 — nunca
-- grava inbox sem outbox.
--
-- Nenhum registro é apagado automaticamente, nem mesmo depois de publicado.

BEGIN;

CREATE TABLE IF NOT EXISTS public.webhook_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id UUID NOT NULL,
  exchange_name TEXT NOT NULL,
  routing_key TEXT NOT NULL,
  -- Somente referências e metadados. O payload bruto continua só na inbox e é
  -- carregado pelo worker através de inbox_id.
  message_payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_outbox_status_check
    CHECK (status IN ('pending', 'publishing', 'published', 'retry', 'dead_letter')),
  -- RESTRICT de propósito: apagar um evento da inbox não pode arrastar em
  -- silêncio a prova de que ele foi (ou não) publicado.
  CONSTRAINT webhook_outbox_inbox_fk
    FOREIGN KEY (inbox_id) REFERENCES public.webhook_inbox (id) ON DELETE RESTRICT
);

-- Idempotência da publicação: reentrega do mesmo evento não cria segunda
-- mensagem, e permite reparar inbox que ficou sem outbox.
CREATE UNIQUE INDEX IF NOT EXISTS ux_webhook_outbox_inbox_routing
  ON public.webhook_outbox (inbox_id, routing_key);

-- Fila de trabalho do publicador: só o que está elegível agora.
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_claim
  ON public.webhook_outbox (available_at, id)
  WHERE status IN ('pending', 'retry');

-- Recuperação de lease expirado (publicador que morreu no meio).
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_lease
  ON public.webhook_outbox (lease_expires_at)
  WHERE status = 'publishing';

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_inbox
  ON public.webhook_outbox (inbox_id);

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_status_created
  ON public.webhook_outbox (status, created_at DESC);

COMMIT;
