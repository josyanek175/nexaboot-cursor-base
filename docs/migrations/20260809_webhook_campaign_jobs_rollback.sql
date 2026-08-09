-- =============================================================================
-- ROLLBACK — tarefas duráveis de resposta de campanha.
-- =============================================================================
-- Pare o message-worker antes. DROP TABLE apaga as tarefas ainda pendentes
-- (payload de campanha nesta tabela). As mensagens e a inbox continuam
-- intactas. Prefira o rollback operacional por flags; só rode este script
-- após dump/backup confirmado. Não use durante incidente.

BEGIN;

DROP TABLE IF EXISTS public.webhook_campaign_jobs;

COMMIT;
