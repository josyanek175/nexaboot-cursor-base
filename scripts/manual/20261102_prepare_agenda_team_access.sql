-- Preparacao LIMITADA: Agenda + Equipes e numeros.
-- Gerado das migracoes publicadas na main 3fa09e0; nao executar as migracoes antigas em lote.
-- Antes: confirmar que a WEB DE PRODUCAO usa este banco/servidor e ter backup recuperavel.
-- Executar O ARQUIVO INTEIRO, do BEGIN ao COMMIT. Nao deixar transacao aberta entre trechos.
-- Nao apaga nem atualiza registros existentes; adiciona seis tabelas e indices.
-- Recusa outro nome de banco ou recursos ja existentes. Nessas situacoes, parar e revisar.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
DO $guard$
DECLARE expected record;
BEGIN
 IF current_database() <> 'nexabootprincipal' THEN
   RAISE EXCEPTION 'Banco incorreto. Este arquivo foi preparado para nexabootprincipal.';
 END IF;
 FOR expected IN SELECT * FROM (VALUES
   ('companies','id'),('users','id'),('users','company_id'),
   ('whatsapp_channels','id'),('whatsapp_channels','company_id')
 ) AS e(table_name,column_name) LOOP
   IF NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid=to_regclass('public.'||expected.table_name)
       AND a.attname=expected.column_name AND a.attnum>0 AND NOT a.attisdropped
       AND a.atttypid='uuid'::regtype
   ) THEN
     RAISE EXCEPTION 'Pre-requisito ausente ou tipo inesperado: public.%.% deve ser uuid.', expected.table_name, expected.column_name;
   END IF;
 END LOOP;
 IF EXISTS (
   SELECT 1 FROM (VALUES ('company_operations_settings'),('company_teams'),
     ('company_team_members'),('company_channel_grants'),('clinic_professionals'),('clinic_appointments')) AS e(name)
   WHERE to_regclass('public.'||name) IS NOT NULL
 ) THEN
   RAISE EXCEPTION 'Uma das estruturas ja existe. Nao repetir nem adaptar este arquivo sem novo diagnostico.';
 END IF;
END $guard$;
CREATE UNIQUE INDEX IF NOT EXISTS users_company_identity ON public.users(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS channels_company_identity ON public.whatsapp_channels(company_id,id);
CREATE TABLE IF NOT EXISTS public.company_operations_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  waiting_attendant_minutes integer NOT NULL DEFAULT 10 CHECK (waiting_attendant_minutes BETWEEN 1 AND 1440),
  waiting_customer_hours integer NOT NULL DEFAULT 24 CHECK (waiting_customer_hours BETWEEN 1 AND 720),
  restrict_channels boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.company_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  UNIQUE(company_id, id), UNIQUE(company_id, name)
);
CREATE TABLE IF NOT EXISTS public.company_team_members (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  team_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  PRIMARY KEY(company_id, team_id, user_id),
  FOREIGN KEY(company_id,user_id) REFERENCES public.users(company_id,id) ON DELETE CASCADE,
  FOREIGN KEY(company_id, team_id) REFERENCES public.company_teams(company_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.company_channel_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  team_id uuid,
  CHECK ((user_id IS NOT NULL)::int + (team_id IS NOT NULL)::int = 1),
  FOREIGN KEY(company_id,channel_id) REFERENCES public.whatsapp_channels(company_id,id) ON DELETE CASCADE,
  FOREIGN KEY(company_id,user_id) REFERENCES public.users(company_id,id) ON DELETE CASCADE,
  FOREIGN KEY(company_id, team_id) REFERENCES public.company_teams(company_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS company_channel_user_grant ON public.company_channel_grants(company_id, channel_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS company_channel_team_grant ON public.company_channel_grants(company_id, channel_id, team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS company_team_user_lookup ON public.company_team_members(company_id, user_id);

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

-- Conferencia final: os seis campos devem conter nomes de tabelas, nunca NULL.
SELECT current_database() AS banco,
 to_regclass('public.company_operations_settings') AS configuracoes,
 to_regclass('public.company_teams') AS equipes,
 to_regclass('public.company_team_members') AS membros,
 to_regclass('public.company_channel_grants') AS liberacoes,
 to_regclass('public.clinic_professionals') AS profissionais,
 to_regclass('public.clinic_appointments') AS agendamentos;
