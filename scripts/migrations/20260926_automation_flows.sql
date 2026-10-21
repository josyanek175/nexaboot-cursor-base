-- Fluxos de atendimento e vendas por empresa.
-- Um número fica em no máximo um fluxo de atendimento.
-- O fluxo de vendas usa o canal só no disparo.

CREATE TABLE IF NOT EXISTS public.automation_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('attendance', 'sales')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  definition jsonb NOT NULL DEFAULT '{"entryStepId":null,"steps":[]}'::jsonb,
  dispatch_channel_id uuid,
  meta_template_name text,
  meta_template_language text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_flows_company_idx
  ON public.automation_flows (company_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.automation_flow_channels (
  flow_id uuid NOT NULL REFERENCES public.automation_flows(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  company_id uuid NOT NULL,
  PRIMARY KEY (flow_id, channel_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_flow_channels_one_per_number
  ON public.automation_flow_channels (channel_id);

CREATE TABLE IF NOT EXISTS public.automation_sessions (
  conversation_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  flow_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  step_id text,
  status text NOT NULL DEFAULT 'waiting',
  collected jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'inbound',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  flow_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  conversation_id uuid,
  label text NOT NULL,
  days integer NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_reminders_company_idx
  ON public.automation_reminders (company_id, status, due_at);
