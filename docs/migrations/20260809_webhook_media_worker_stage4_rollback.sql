-- =============================================================================
-- ROLLBACK — colunas de storage do media-worker (ETAPA 4).
-- =============================================================================
-- Prefira rollback operacional: WEBHOOK_MEDIA_WORKER_ENABLED=false.
-- DROP COLUMN apaga storage_key/media_checksum das mensagens. Não rode durante
-- incidente. Somente após dump/backup confirmado. Não apaga webhook_media_jobs
-- nem media_base64/media_url.

BEGIN;

DROP INDEX IF EXISTS public.idx_messages_storage_key;

DROP INDEX IF EXISTS public.idx_messages_media_status;

-- Restaura o índice da Etapa 3.
CREATE INDEX IF NOT EXISTS idx_messages_media_status
  ON public.messages (media_status)
  WHERE media_status IN ('pending', 'processing');

ALTER TABLE public.messages DROP COLUMN IF EXISTS media_checksum;
ALTER TABLE public.messages DROP COLUMN IF EXISTS storage_key;

COMMIT;
