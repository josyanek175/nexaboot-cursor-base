-- Overlay de templates WhatsApp para envio no atendimento.
-- Fonte oficial Meta: public.meta_message_templates (FK).
-- NÃO popula presets automaticamente — vincular após sync Meta.

CREATE TABLE IF NOT EXISTS public.attendance_whatsapp_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  meta_template_id UUID NOT NULL REFERENCES public.meta_message_templates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_whatsapp_templates_company_meta_uniq
  ON public.attendance_whatsapp_templates (company_id, meta_template_id);

CREATE INDEX IF NOT EXISTS idx_attendance_whatsapp_templates_company_active
  ON public.attendance_whatsapp_templates (company_id, active, updated_at DESC);
