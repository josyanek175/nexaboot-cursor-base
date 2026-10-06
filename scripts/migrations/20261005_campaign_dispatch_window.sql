-- Janela progressiva de disparo entre campanhas (por empresa).
-- Defaults: 7 dias (1º), 10 dias (2º), 30 dias (3º+).

CREATE TABLE IF NOT EXISTS public.company_campaign_dispatch_settings (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  first_window_days INT NOT NULL DEFAULT 7,
  second_window_days INT NOT NULL DEFAULT 10,
  third_window_days INT NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_campaign_dispatch_settings_days_check'
  ) THEN
    ALTER TABLE public.company_campaign_dispatch_settings
      ADD CONSTRAINT company_campaign_dispatch_settings_days_check CHECK (
        first_window_days BETWEEN 1 AND 365
        AND second_window_days BETWEEN 1 AND 365
        AND third_window_days BETWEEN 1 AND 365
      );
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_company_status_sent
  ON public.campaign_contacts (company_id, status, sent_at DESC)
  WHERE status = 'sent' AND sent_at IS NOT NULL;
