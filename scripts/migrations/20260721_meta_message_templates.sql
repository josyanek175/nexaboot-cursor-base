-- Migration: templates Meta para campanhas (NÃO aplicar automaticamente).
-- Aplicar MANUALMENTE em produção ANTES do deploy inicial.
-- Idempotente: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- Não remove, não recria e não altera tipos de colunas existentes.

ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS meta_template_id TEXT;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS meta_template_name TEXT;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS meta_language_code TEXT;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS meta_variable_mappings JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.meta_message_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
  meta_template_id TEXT,
  template_name TEXT NOT NULL,
  language_code TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  components JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT false,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, template_name, language_code)
);

CREATE INDEX IF NOT EXISTS idx_meta_message_templates_company_channel
  ON public.meta_message_templates (company_id, channel_id, active);

CREATE INDEX IF NOT EXISTS idx_meta_message_templates_status
  ON public.meta_message_templates (channel_id, status)
  WHERE active = true;

-- Após esta migration já aplicada, ensureCampaignsSchema (boot) apenas reexecuta
-- os mesmos IF NOT EXISTS: nenhum DDL efetivo (no-op seguro).
