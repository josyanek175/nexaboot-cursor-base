-- Apply to the isolated DEV database before enabling the new operations features.
BEGIN;
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
CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  credential_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_user_created ON public.password_reset_tokens(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS public.internal_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid REFERENCES public.companies(id),
  tenant_id text, name text NOT NULL, type text NOT NULL DEFAULT 'group',
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.internal_chat_members (
  chat_id uuid NOT NULL REFERENCES public.internal_chats(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(), last_read_at timestamptz,
  PRIMARY KEY(chat_id,user_id)
);
CREATE TABLE IF NOT EXISTS public.internal_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.internal_chats(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  attachment_path text, attachment_mime_type text, attachment_filename text,
  attachment_original_name text, attachment_size integer, attachment_type text
);
CREATE TABLE IF NOT EXISTS public.internal_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  chat_id uuid NOT NULL REFERENCES public.internal_chats(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.internal_messages(id) ON DELETE CASCADE,
  read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS internal_messages_chat_idx ON public.internal_messages(chat_id,created_at);
CREATE INDEX IF NOT EXISTS internal_chats_company_lookup ON public.internal_chats(company_id);
ALTER TABLE public.internal_chats ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
CREATE OR REPLACE FUNCTION public.nexa_password_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.password_hash IS DISTINCT FROM NEW.password_hash THEN
    NEW.password_changed_at=clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS nexa_password_changed ON public.users;
CREATE TRIGGER nexa_password_changed BEFORE UPDATE OF password_hash ON public.users
FOR EACH ROW EXECUTE FUNCTION public.nexa_password_changed();
CREATE INDEX IF NOT EXISTS messages_campaign_expiry ON public.messages(conversation_id,created_at DESC)
WHERE direction='out' AND raw_payload->>'origin'='CAMPANHA';
COMMIT;
