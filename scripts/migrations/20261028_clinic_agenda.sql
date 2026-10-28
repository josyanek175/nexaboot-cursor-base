-- Módulo isolado. Aplicar somente no banco de DESENVOLVIMENTO confirmado.
-- Não altera tabelas de mensagens, contatos, fluxos ou atendimentos.
BEGIN;
CREATE TABLE IF NOT EXISTS public.clinic_professionals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  name text NOT NULL, specialty text NOT NULL DEFAULT '',
  duration integer NOT NULL CHECK (duration BETWEEN 5 AND 180),
  opens time NOT NULL, closes time NOT NULL CHECK (closes > opens),
  weekdays jsonb NOT NULL DEFAULT '[1,2,3,4,5]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id)
);
CREATE INDEX IF NOT EXISTS clinic_professionals_company ON public.clinic_professionals(company_id);
CREATE TABLE IF NOT EXISTS public.clinic_appointments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  professional_id uuid NOT NULL,
  contact_id uuid,
  starts_at timestamp NOT NULL,
  duration integer NOT NULL CHECK (duration BETWEEN 5 AND 180),
  kind text NOT NULL CHECK (kind IN ('appointment','block')),
  patient text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', service text NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','confirmed','arrived','completed','absent','cancelled')),
  reminder_hours integer NOT NULL DEFAULT 24 CHECK (reminder_hours IN (0,2,24,48)),
  reminder_copied_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id,professional_id) REFERENCES public.clinic_professionals(company_id,id)
);
CREATE INDEX IF NOT EXISTS clinic_appointments_company_day ON public.clinic_appointments(company_id,starts_at);
-- Somente o backend com conexão privilegiada opera estas tabelas.
-- Nenhuma política abre acesso direto para clientes/SDKs públicos.
ALTER TABLE public.clinic_professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_appointments ENABLE ROW LEVEL SECURITY;
COMMIT;
