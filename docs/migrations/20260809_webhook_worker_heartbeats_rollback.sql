-- Rollback heartbeats. Não toca inbox/outbox/jobs/messages.
-- Prefira desligar o worker por flag. Só rode após dump se necessário.

BEGIN;

DROP TABLE IF EXISTS public.webhook_worker_heartbeats;

COMMIT;
