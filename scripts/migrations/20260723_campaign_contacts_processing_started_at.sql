-- PROPOSTA — NÃO APLICAR sem aprovação explícita.
-- Alternativa preferida no código atual: usar campaign_send_queue.locked_at (coluna existente).
-- Aplicar somente se locked_at na fila não for suficiente (ex.: contatos em processing sem linha na fila).

-- Idempotente. Lock esperado em PostgreSQL: ACCESS EXCLUSIVE breve na ADD COLUMN;
-- em tabelas grandes, preferir janela de manutenção.

ALTER TABLE public.campaign_contacts
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

COMMENT ON COLUMN public.campaign_contacts.processing_started_at IS
  'Timestamp da reserva pending→processing; usado para stale recovery seguro.';

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_processing_started
  ON public.campaign_contacts (campaign_id, processing_started_at)
  WHERE status = 'processing';
