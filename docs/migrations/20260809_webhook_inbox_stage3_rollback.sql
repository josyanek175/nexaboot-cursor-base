-- =============================================================================
-- ROLLBACK — ajustes da inbox para o message-worker (ETAPA 3).
-- =============================================================================
-- Pare o serviço webhook-message-worker e volte o código da etapa 3 ANTES de
-- rodar este script: a ingestão da etapa 3 grava conversation_key e falharia
-- sem a coluna (respondendo 503, nunca 200 sem persistência).
--
-- Reverta primeiro 20260809_webhook_media_jobs_rollback.sql, porque
-- webhook_media_jobs tem FK para public.webhook_inbox.
--
-- O CHECK volta ao conjunto original de status. Se ainda existir alguma linha
-- em 'queued', o ADD CONSTRAINT falha de propósito: resolva o backlog antes de
-- reverter, em vez de perder a informação de estado.
--
-- Nenhum payload é apagado. A coluna conversation_key é descartada, mas a
-- chave continua derivável do payload bruto preservado em public.webhook_inbox.

BEGIN;

DROP INDEX IF EXISTS public.idx_webhook_inbox_lease;
DROP INDEX IF EXISTS public.idx_webhook_inbox_status_received;
DROP INDEX IF EXISTS public.idx_webhook_inbox_conversation_key;

ALTER TABLE public.webhook_inbox
  DROP CONSTRAINT IF EXISTS webhook_inbox_status_check;

ALTER TABLE public.webhook_inbox
  ADD CONSTRAINT webhook_inbox_status_check
  CHECK (status IN ('pending', 'processing', 'retry', 'processed', 'dead_letter'));

ALTER TABLE public.webhook_inbox
  DROP COLUMN IF EXISTS conversation_key;

COMMIT;
