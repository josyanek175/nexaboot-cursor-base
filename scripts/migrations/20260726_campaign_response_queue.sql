-- Migration: cor de campanha + fila de respostas (NÃO aplicar automaticamente).
-- Aplicar MANUALMENTE no banco dev após confirmar DATABASE_URL.
-- Idempotente: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- Não remove, não recria e não altera tipos de colunas existentes.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#6B7280';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaigns_color_hex_check'
  ) THEN
    ALTER TABLE public.campaigns
      ADD CONSTRAINT campaigns_color_hex_check
      CHECK (color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END $$;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS campaign_service_status TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_campaign_service_status_check'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_campaign_service_status_check
      CHECK (
        campaign_service_status IS NULL
        OR campaign_service_status IN (
          'awaiting_reply',
          'in_service',
          'answered',
          'completed',
          'not_interested',
          'opt_out'
        )
      );
  END IF;
END $$;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS campaign_last_inbound_at TIMESTAMPTZ;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS campaign_last_human_reply_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_campaign_queue
  ON public.conversations (
    company_id,
    campaign_service_status,
    campaign_last_inbound_at DESC NULLS LAST
  )
  WHERE campaign_reply_campaign_id IS NOT NULL;

-- Após esta migration já aplicada, ensureCampaignsSchema (boot) apenas reexecuta
-- os mesmos IF NOT EXISTS: nenhum DDL efetivo (no-op seguro).
