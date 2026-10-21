-- =============================================================================
-- PROPOSTA — unicidade de conversa (NÃO APLICAR automaticamente).
-- =============================================================================
-- Bloqueador de produção: hoje a unicidade (company_id, whatsapp_channel_id,
-- contact_id) é só convenção de código. Sem índice UNIQUE, duas escritas
-- concorrentes podem criar conversas duplicadas.
--
-- Pré-requisito OBRIGATÓRIO antes de criar o índice:
--   1. Rodar ensureConversationsDedup (ou equivalente) e confirmar
--      COUNT(*) = 0 no SELECT de duplicados abaixo.
--   2. Dump de public.conversations.
--   3. Aplicar esta migration em janela controlada.
--
-- Este arquivo é documentação executável. NÃO faz parte do pipeline automático
-- da Etapa 3. Não aplicar sem aprovação explícita.

-- Diagnóstico (somente leitura):
-- SELECT company_id, whatsapp_channel_id, contact_id, count(*)
-- FROM public.conversations
-- WHERE contact_id IS NOT NULL
--   AND status IS DISTINCT FROM 'merged'
--   AND status IS DISTINCT FROM 'archived'
-- GROUP BY 1, 2, 3
-- HAVING count(*) > 1;

BEGIN;

-- Índice parcial: conversas "vivas" (não merged/archived) são únicas por
-- empresa + canal + contato. Conversas merged/archived podem coexistir.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_company_channel_contact_active_uniq
  ON public.conversations (company_id, whatsapp_channel_id, contact_id)
  WHERE contact_id IS NOT NULL
    AND status IS DISTINCT FROM 'merged'
    AND status IS DISTINCT FROM 'archived';

COMMIT;
