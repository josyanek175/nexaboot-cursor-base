-- Add shared attendance flag and ATENDENTE_GERAL role
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS shared_attendance boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ATENDENTE_GERAL' AND enumtypid = 'public.app_role'::regtype) THEN
    ALTER TYPE public.app_role ADD VALUE 'ATENDENTE_GERAL';
  END IF;
END $$;