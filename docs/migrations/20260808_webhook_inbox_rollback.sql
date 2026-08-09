-- =============================================================================
-- ROLLBACK — inbox durável de webhooks (ETAPA 1).
-- =============================================================================
-- Desligue WEBHOOK_DURABLE_INBOX_ENABLED ANTES de rodar este script; caso
-- contrário a ingestão passa a responder 503 por falta da tabela.
--
-- Atenção: remove permanentemente os payloads ainda não processados.
-- Faça dump de public.webhook_inbox antes se quiser preservá-los.

BEGIN;

DROP TABLE IF EXISTS public.webhook_inbox;

COMMIT;
