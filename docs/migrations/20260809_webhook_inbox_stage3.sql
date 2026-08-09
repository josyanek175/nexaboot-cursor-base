-- =============================================================================
-- Inbox durável de webhooks — ETAPA 3 (message-worker idempotente).
-- =============================================================================
-- Ajustes aditivos na tabela criada em 20260808_webhook_inbox.sql. Nenhuma
-- coluna é removida, nenhum registro é apagado e nenhum payload é tocado.
--
-- 1) conversation_key: o worker serializa o processamento por conversa usando
--    advisory lock transacional. A chave já é extraída na ingestão (remoteJid
--    na Evolution, wa_id/from na Meta) e viajava só na mensagem do RabbitMQ.
--    O worker não confia no envelope: ele relê a chave daqui.
-- 2) status 'queued': amplia o CHECK para o estado intermediário entre a
--    ingestão e o consumo. O CHECK antigo rejeitaria a linha.
--
-- Aplicação: manual, DEPOIS de 20260808_webhook_inbox.sql.
-- Rollback:  20260809_webhook_inbox_stage3_rollback.sql
--
-- Precondição operacional: aplicar ANTES de subir o código da etapa 3, porque
-- a ingestão passa a gravar conversation_key. Sem a coluna, o INSERT falha e a
-- ingestão responde 503 — nunca grava evento pela metade.

BEGIN;

ALTER TABLE public.webhook_inbox
  ADD COLUMN IF NOT EXISTS conversation_key TEXT;

-- Diagnóstico e reprocessamento por conversa. Parcial porque eventos sem
-- conversa (connection.update, por exemplo) não participam da serialização.
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_conversation_key
  ON public.webhook_inbox (company_id, conversation_key)
  WHERE conversation_key IS NOT NULL;

-- Amplia o conjunto de status aceitos sem afetar as linhas existentes.
ALTER TABLE public.webhook_inbox
  DROP CONSTRAINT IF EXISTS webhook_inbox_status_check;

ALTER TABLE public.webhook_inbox
  ADD CONSTRAINT webhook_inbox_status_check
  CHECK (status IN ('pending', 'queued', 'processing', 'retry', 'processed', 'dead_letter'));

-- Backlog do worker por status e idade (health/métricas da etapa 3).
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_status_received
  ON public.webhook_inbox (status, received_at);

-- Recuperação de lease expirado (worker que morreu no meio do processamento).
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_lease
  ON public.webhook_inbox (lease_expires_at)
  WHERE status = 'processing';

COMMIT;
