-- =============================================================================
-- ROLLBACK — outbox transacional de webhooks (ETAPA 2).
-- =============================================================================
-- Desligue WEBHOOK_DURABLE_INBOX_ENABLED ANTES de rodar este script. Com a flag
-- ligada e a outbox ausente, a transação de ingestão falha e o endpoint passa a
-- responder 503 (nunca grava inbox sem outbox).
--
-- Pare também o serviço webhook-outbox-publisher antes de reverter.
--
-- Atenção: remove permanentemente as mensagens ainda não publicadas. Faça dump
-- de public.webhook_outbox antes se quiser preservá-las.
--
-- Este rollback NÃO toca em public.webhook_inbox: os payloads brutos continuam
-- intactos e podem ser republicados depois que a outbox for recriada.

BEGIN;

DROP TABLE IF EXISTS public.webhook_outbox;

COMMIT;
