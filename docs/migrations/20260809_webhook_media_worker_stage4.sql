-- =============================================================================
-- Media-worker — ETAPA 4 (colunas de armazenamento na mensagem).
-- =============================================================================
-- A tabela webhook_media_jobs já existe (Etapa 3). Esta migration adiciona
-- storage_key / media_checksum em public.messages e amplia o índice parcial
-- de media_status para incluir 'retry'.
--
-- media_status (TEXT, sem CHECK):
--   NULL | pending | processing | available | retry | failed
-- (valores legados 'ready' continuam legíveis; o worker novo grava 'available')
--
-- Aplicação: manual, DEPOIS de 20260809_webhook_media_jobs.sql
-- Rollback:  20260809_webhook_media_worker_stage4_rollback.sql
-- NÃO aplicar automaticamente.

BEGIN;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS storage_key TEXT;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_checksum TEXT;

DROP INDEX IF EXISTS public.idx_messages_media_status;

CREATE INDEX IF NOT EXISTS idx_messages_media_status
  ON public.messages (media_status)
  WHERE media_status IN ('pending', 'processing', 'retry');

CREATE INDEX IF NOT EXISTS idx_messages_storage_key
  ON public.messages (storage_key)
  WHERE storage_key IS NOT NULL;

COMMIT;
