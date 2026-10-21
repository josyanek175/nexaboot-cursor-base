-- Horário de acesso por perfil (quando entra), separado das permissões.
-- Idempotente. Não apaga dados. Não altera sessões existentes.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS timezone TEXT;

CREATE TABLE IF NOT EXISTS public.company_access_hour_settings (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  admin_geral_bypass BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.company_access_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  force_logout_outside_schedule BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT company_access_schedules_profile_chk CHECK (
    profile IN (
      'SUPER_ADMIN', 'TI', 'ADMIN_GERAL', 'ADMIN_EMPRESA',
      'GERENTE', 'SUPERVISOR', 'ATENDENTE', 'ATENDENTE_GERAL'
    )
  ),
  CONSTRAINT company_access_schedules_company_profile_uq UNIQUE (company_id, profile)
);

CREATE INDEX IF NOT EXISTS idx_company_access_schedules_company
  ON public.company_access_schedules (company_id);

CREATE TABLE IF NOT EXISTS public.company_access_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES public.company_access_schedules(id) ON DELETE CASCADE,
  weekday SMALLINT NOT NULL,
  blocked BOOLEAN NOT NULL DEFAULT false,
  start_time TIME NULL,
  end_time TIME NULL,
  CONSTRAINT company_access_windows_weekday_chk CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT company_access_windows_schedule_weekday_uq UNIQUE (schedule_id, weekday)
);

CREATE INDEX IF NOT EXISTS idx_company_access_windows_schedule
  ON public.company_access_windows (schedule_id);
