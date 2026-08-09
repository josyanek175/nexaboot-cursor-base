-- =============================================================================
-- Tarefas duráveis de resposta de campanha — ETAPA 3 (correção de garantia).
-- =============================================================================
-- O message-worker grava contato/conversa/mensagem e marca a inbox processed
-- na mesma transação. A resposta de campanha NÃO pode ficar só como chamada
-- pós-COMMIT: se ela falhar, a reentrega encontra processed e o efeito se
-- perde. Esta tabela nasce DENTRO da transação principal; o processamento
-- imediato após o COMMIT é só otimização.
--
-- Aplicação: manual, DEPOIS de 20260808_webhook_inbox.sql e
-- 20260809_webhook_media_jobs.sql (FK para messages).
-- Rollback:  20260809_webhook_campaign_jobs_rollback.sql

BEGIN;

CREATE TABLE IF NOT EXISTS public.webhook_campaign_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id UUID NOT NULL,
  message_id UUID NOT NULL,
  campaign_id UUID,
  company_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  external_message_id TEXT,
  phone TEXT NOT NULL,
  response_text TEXT,
  allow_empty_text BOOLEAN NOT NULL DEFAULT false,
  -- Metadados não sensíveis (intent hints, etc.). Sem payload bruto.
  job_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_campaign_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'retry', 'processed', 'dead_letter')),
  CONSTRAINT webhook_campaign_jobs_inbox_fk
    FOREIGN KEY (inbox_id) REFERENCES public.webhook_inbox (id) ON DELETE RESTRICT,
  CONSTRAINT webhook_campaign_jobs_message_fk
    FOREIGN KEY (message_id) REFERENCES public.messages (id) ON DELETE RESTRICT
);

-- Uma mensagem inbound gera no máximo uma tarefa de campanha.
CREATE UNIQUE INDEX IF NOT EXISTS ux_webhook_campaign_jobs_message
  ON public.webhook_campaign_jobs (message_id);

CREATE INDEX IF NOT EXISTS idx_webhook_campaign_jobs_claim
  ON public.webhook_campaign_jobs (available_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS idx_webhook_campaign_jobs_lease
  ON public.webhook_campaign_jobs (lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_webhook_campaign_jobs_inbox
  ON public.webhook_campaign_jobs (inbox_id);

CREATE INDEX IF NOT EXISTS idx_webhook_campaign_jobs_status_created
  ON public.webhook_campaign_jobs (status, created_at DESC);

COMMIT;
