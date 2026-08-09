-- =============================================================================
-- ROLLBACK — fila durável de mídia de webhooks (ETAPA 3).
-- =============================================================================
-- Pare o serviço webhook-message-worker antes de rodar este script. Com o
-- worker ativo e a tabela ausente, a transação de processamento falha e o
-- evento volta para retry — nada é perdido, mas o backlog cresce.
--
-- Atenção: remove permanentemente as tarefas de mídia ainda não baixadas. As
-- mensagens continuam intactas em public.messages com media_status='pending',
-- e as tarefas podem ser reconstruídas a partir do payload bruto preservado em
-- public.webhook_inbox.
--
-- Este rollback NÃO toca em public.webhook_inbox nem em public.messages.

BEGIN;

DROP TABLE IF EXISTS public.webhook_media_jobs;

-- messages.media_status é preservada de propósito: é uma coluna aditiva e
-- anulável, e descartá-la apagaria o estado das mensagens cujo anexo ficou
-- pendente. Para removê-la mesmo assim, depois de conferir que nenhuma linha
-- está em 'pending'/'processing':
--   DROP INDEX IF EXISTS public.idx_messages_media_status;
--   ALTER TABLE public.messages DROP COLUMN IF EXISTS media_status;

COMMIT;
