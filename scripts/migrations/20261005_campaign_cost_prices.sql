-- Preços estimados de disparo Meta (R$) por empresa.

CREATE TABLE IF NOT EXISTS public.company_campaign_cost_prices (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  marketing_brl NUMERIC(12,4) NOT NULL DEFAULT 0.3217,
  utility_brl NUMERIC(12,4) NOT NULL DEFAULT 0.0350,
  authentication_brl NUMERIC(12,4) NOT NULL DEFAULT 0.0350,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL
);
