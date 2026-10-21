-- =============================================================================
-- Fila durável de mídia de webhooks — ETAPA 3 (só a tabela).
-- =============================================================================
-- Hoje o webhook da Evolution baixa e descriptografa a mídia DENTRO da
-- requisição: um POST para /chat/getBase64FromMediaMessage com 20s de timeout,
-- e o base64 inteiro vai para public.messages.media_base64. É o que segura o
-- slot do pool e atrasa a resposta.
--
-- O message-worker inverte isso: grava a mensagem imediatamente com
-- media_status='pending', enfileira aqui os metadados necessários para baixar
-- depois e só então dá ACK. O download continua fora de qualquer transação.
--
-- O media-worker que consome esta fila NÃO faz parte desta etapa. A tabela
-- nasce vazia e inerte até ele existir.
--
-- Aplicação: manual, DEPOIS de 20260808_webhook_inbox.sql (existe FK para ela).
-- Rollback:  20260809_webhook_media_jobs_rollback.sql

BEGIN;

-- Estado da mídia na própria mensagem, para a interface saber que o anexo
-- ainda está a caminho em vez de mostrar erro. Aditivo: mensagens antigas
-- ficam NULL e continuam sendo lidas por media_base64/media_url como hoje.
--   NULL         → mensagem sem mídia, ou fluxo legado (download inline)
--   'pending'    → tarefa enfileirada, download ainda não executado
--   'processing' → media-worker baixando
--   'ready'      → conteúdo disponível
--   'failed'     → esgotou as tentativas; media_error explica
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_status TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_media_status
  ON public.messages (media_status)
  WHERE media_status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS public.webhook_media_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id UUID NOT NULL,
  message_id UUID NOT NULL,
  provider TEXT NOT NULL,
  channel_id UUID,
  instance_name TEXT,
  external_message_id TEXT,
  media_type TEXT,
  mime_type TEXT,
  file_name TEXT,
  -- Só o necessário para o download posterior (chaves e ponteiros do provedor).
  -- Nunca base64, nunca o conteúdo da mensagem.
  media_reference JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  storage_key TEXT,
  checksum TEXT,
  size_bytes BIGINT,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_media_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'retry', 'processed', 'dead_letter')),
  -- RESTRICT nos dois lados: apagar inbox ou mensagem não pode arrastar em
  -- silêncio a prova de que a mídia foi (ou não) baixada.
  CONSTRAINT webhook_media_jobs_inbox_fk
    FOREIGN KEY (inbox_id) REFERENCES public.webhook_inbox (id) ON DELETE RESTRICT,
  CONSTRAINT webhook_media_jobs_message_fk
    FOREIGN KEY (message_id) REFERENCES public.messages (id) ON DELETE RESTRICT
);

-- Idempotência: uma mensagem do WhatsApp carrega no máximo uma mídia, então
-- message_id é a chave natural. Reentrega do mesmo evento reencontra a tarefa
-- em vez de criar a segunda.
CREATE UNIQUE INDEX IF NOT EXISTS ux_webhook_media_jobs_message
  ON public.webhook_media_jobs (message_id);

-- Fila de trabalho do futuro media-worker: só o que está elegível agora.
CREATE INDEX IF NOT EXISTS idx_webhook_media_jobs_claim
  ON public.webhook_media_jobs (available_at, id)
  WHERE status IN ('pending', 'retry');

-- Recuperação de lease expirado.
CREATE INDEX IF NOT EXISTS idx_webhook_media_jobs_lease
  ON public.webhook_media_jobs (lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_webhook_media_jobs_inbox
  ON public.webhook_media_jobs (inbox_id);

CREATE INDEX IF NOT EXISTS idx_webhook_media_jobs_status_created
  ON public.webhook_media_jobs (status, created_at DESC);

COMMIT;
