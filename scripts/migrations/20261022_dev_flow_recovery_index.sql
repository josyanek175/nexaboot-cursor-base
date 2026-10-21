-- DEV/HOMOLOGAÇÃO. Opcional para a recuperação de fluxos pelo worker durável.
-- Não cria fila ou tabela; não executar automaticamente em produção.
CREATE INDEX IF NOT EXISTS messages_pending_flow_recovery
ON public.messages (conversation_id,created_at,id)
WHERE direction='in' AND raw_payload->'__nexaFlow'->>'status' IN ('pending','retry','processing');
