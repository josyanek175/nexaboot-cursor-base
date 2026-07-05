-- =============================================================================
-- NexaBoot — Schema completo para banco DEV (PostgreSQL)
-- Banco alvo: nexaboot_dev
--
-- Idempotente: CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- NÃO apaga dados existentes (exceto se você rodar o bloco opcional DROP SCHEMA).
-- NÃO executar em produção.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- OPCIONAL (DEV incompleto): limpar schema public e recomeçar do zero.
-- Descomente SOMENTE se tiver certeza de que está no banco DEV.
-- -----------------------------------------------------------------------------
-- DROP SCHEMA public CASCADE;
-- CREATE SCHEMA public;
-- GRANT ALL ON SCHEMA public TO postgres;
-- GRANT ALL ON SCHEMA public TO public;

-- -----------------------------------------------------------------------------
-- Extensões
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Tenants (compatibilidade com users.tenant_id TEXT)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.tenants (id, name, slug)
VALUES ('default', 'Default', 'default')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Companies
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  active BOOLEAN NOT NULL DEFAULT true,
  avatar_url TEXT,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE public.users ALTER COLUMN tenant_id SET DEFAULT 'default';
UPDATE public.users SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE public.users ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE public.users ALTER COLUMN role SET DEFAULT 'USER';
UPDATE public.users SET role = 'USER' WHERE role IS NULL;
ALTER TABLE public.users ALTER COLUMN role SET NOT NULL;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
UPDATE public.users SET active = true WHERE active IS NULL;
ALTER TABLE public.users ALTER COLUMN active SET NOT NULL;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
UPDATE public.users SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
UPDATE public.users SET updated_at = now() WHERE updated_at IS NULL;
ALTER TABLE public.users ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS company_id UUID;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_email_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_company_id_fkey'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_unique
  ON public.users (tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON public.users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_company ON public.users (company_id);

-- -----------------------------------------------------------------------------
-- Plans + company_subscriptions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  max_whatsapp_channels INT NOT NULL,
  max_users INT,
  max_messages_month INT,
  max_campaigns_month INT,
  allow_automations BOOLEAN NOT NULL DEFAULT false,
  allow_internal_chat BOOLEAN NOT NULL DEFAULT true,
  allow_api_access BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.company_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_whatsapp_channels INT;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_users INT;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_messages_month INT;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_campaigns_month INT;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS allow_automations BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS allow_internal_chat BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS allow_api_access BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_company_subscriptions_company
  ON public.company_subscriptions (company_id);
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_plan
  ON public.company_subscriptions (plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS company_subscriptions_one_active
  ON public.company_subscriptions (company_id)
  WHERE status = 'active';

-- Seed dos planos comerciais (idempotente por code)
INSERT INTO public.plans (
  name, code, description, max_whatsapp_channels,
  allow_automations, allow_internal_chat, allow_api_access, active
) VALUES
  ('Plano Básico 1', 'BASICO_1', 'Até 1 número(s) WhatsApp', 1, false, true, false, true),
  ('Plano Básico 2', 'BASICO_2', 'Até 2 número(s) WhatsApp', 2, false, true, false, true),
  ('Plano Prata', 'PRATA', 'Até 5 número(s) WhatsApp', 5, false, true, false, true),
  ('Plano Gold', 'GOLD', 'Até 10 número(s) WhatsApp', 10, false, true, false, true),
  ('Plano Diamante', 'DIAMANTE', 'Até 20 número(s) WhatsApp', 20, false, true, false, true)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  max_whatsapp_channels = EXCLUDED.max_whatsapp_channels,
  updated_at = now();

-- -----------------------------------------------------------------------------
-- WhatsApp channels
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT,
  channel_type TEXT NOT NULL DEFAULT 'evolution',
  evolution_instance_name TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  last_connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_channels_type_instance
  ON public.whatsapp_channels(channel_type, evolution_instance_name);
CREATE INDEX IF NOT EXISTS idx_channels_company
  ON public.whatsapp_channels(company_id);

-- Meta WhatsApp Cloud API (operacional por canal; access token em whatsapp_channel_secrets).
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS waba_id TEXT;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS phone_number_id TEXT;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS business_id TEXT;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS display_phone_number TEXT;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS token_status TEXT;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS webhook_verify_token TEXT;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS last_error_message TEXT;
ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_meta_phone_number_id
  ON public.whatsapp_channels(phone_number_id)
  WHERE phone_number_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_channels_meta_waba
  ON public.whatsapp_channels(waba_id)
  WHERE channel_type = 'meta';

CREATE INDEX IF NOT EXISTS idx_channels_company_type
  ON public.whatsapp_channels(company_id, channel_type);

CREATE TABLE IF NOT EXISTS public.whatsapp_channel_secrets (
  channel_id UUID PRIMARY KEY REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
  access_token_ciphertext TEXT,
  token_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.meta_webhook_event_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
  channel_id UUID REFERENCES public.whatsapp_channels(id) ON DELETE SET NULL,
  phone_number_id TEXT,
  event_type TEXT,
  signature_valid BOOLEAN NOT NULL DEFAULT false,
  processing_status TEXT NOT NULL DEFAULT 'received',
  http_status INT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_webhook_logs_company
  ON public.meta_webhook_event_logs(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_meta_webhook_logs_channel
  ON public.meta_webhook_event_logs(channel_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Contacts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT,
  external_jid TEXT,
  contact_type TEXT NOT NULL DEFAULT 'individual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS reference TEXT;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS avatar_color TEXT;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS name_source TEXT;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS phone_match TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_company_phone
  ON public.contacts(company_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_company_phonematch
  ON public.contacts(company_id, phone_match);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_phonematch_active_uniq
  ON public.contacts(company_id, phone_match)
  WHERE phone_match IS NOT NULL AND btrim(phone_match) <> ''
    AND status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo';

-- -----------------------------------------------------------------------------
-- Conversations
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE RESTRICT,
  whatsapp_channel_id UUID REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_company ON public.conversations(company_id);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON public.conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON public.conversations(whatsapp_channel_id);

-- -----------------------------------------------------------------------------
-- Messages
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE RESTRICT,
  external_id TEXT,
  external_message_id TEXT,
  direction TEXT,
  message_type TEXT,
  message_text TEXT,
  from_me BOOLEAN NOT NULL DEFAULT false,
  raw_payload JSONB,
  media_type TEXT,
  media_mimetype TEXT,
  mime_type TEXT,
  media_filename TEXT,
  media_caption TEXT,
  media_base64 TEXT,
  media_error TEXT,
  media_url TEXT,
  media_seconds INTEGER,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS sent_by_user_id UUID;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS sent_by_name TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reaction_emoji TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reaction_to_message_id TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_size BIGINT;

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_external_id ON public.messages(external_id);
CREATE INDEX IF NOT EXISTS idx_messages_external_message_id ON public.messages(external_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_conv_extid_uniq
  ON public.messages(conversation_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Campaigns
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  whatsapp_channel_id UUID REFERENCES public.whatsapp_channels(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  message_text TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  send_interval_ms INT NOT NULL DEFAULT 5000,
  total_contacts INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS schedule_date DATE;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS window_start_time TIME;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS window_end_time TIME;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'auto_safe';
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS total_replied INT NOT NULL DEFAULT 0;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS total_interested INT NOT NULL DEFAULT 0;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS total_opt_out INT NOT NULL DEFAULT 0;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS template_id UUID;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS source_campaign_id UUID;

CREATE TABLE IF NOT EXISTS public.campaign_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  message_body TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaign_templates_company
  ON public.campaign_templates (company_id, active, updated_at DESC);

ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS greeting_variant TEXT;
ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS closing_variant TEXT;
ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS rendered_message TEXT;
ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;
ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS response_text TEXT;
ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS response_intent TEXT;

-- Opt-out global por empresa (respostas "sair"/"parar"/etc.).
CREATE TABLE IF NOT EXISTS public.opt_out_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  phone_match TEXT,
  source TEXT,
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  campaign_contact_id UUID REFERENCES public.campaign_contacts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS opt_out_contacts_company_phone_uniq
  ON public.opt_out_contacts (company_id, phone);
CREATE INDEX IF NOT EXISTS idx_opt_out_contacts_company_match
  ON public.opt_out_contacts (company_id, phone_match);

-- Origem de resposta de campanha na conversa (badge no Atendimento).
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS campaign_reply_campaign_id UUID;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS campaign_reply_campaign_name TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS campaign_reply_text TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS campaign_reply_intent TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS campaign_reply_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.campaign_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  name TEXT,
  variables JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  sent_at TIMESTAMPTZ,
  provider_message_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.campaign_send_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  campaign_contact_id UUID NOT NULL REFERENCES public.campaign_contacts(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.campaign_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  campaign_contact_id UUID REFERENCES public.campaign_contacts(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_company ON public.campaigns (company_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_company_status ON public.campaigns (company_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_company_created ON public.campaigns (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_company_active
  ON public.campaigns (company_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign ON public.campaign_contacts (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign_status ON public.campaign_contacts (campaign_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_contacts_campaign_phone_uniq
  ON public.campaign_contacts (campaign_id, phone);

CREATE INDEX IF NOT EXISTS idx_campaign_queue_campaign ON public.campaign_send_queue (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_queue_company ON public.campaign_send_queue (company_id);
CREATE INDEX IF NOT EXISTS idx_campaign_queue_pending
  ON public.campaign_send_queue (status, scheduled_for)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign ON public.campaign_events (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_events_company ON public.campaign_events (company_id);

-- -----------------------------------------------------------------------------
-- Attendance: assignments + notifications
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unassigned_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_assignments_one_active
  ON public.conversation_assignments (conversation_id)
  WHERE active = true AND unassigned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_assignments_company
  ON public.conversation_assignments (company_id);
CREATE INDEX IF NOT EXISTS idx_conversation_assignments_user_active
  ON public.conversation_assignments (user_id)
  WHERE active = true AND unassigned_at IS NULL;

CREATE TABLE IF NOT EXISTS public.attendance_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'transfer',
  title TEXT NOT NULL,
  body TEXT,
  from_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_notifications_user
  ON public.attendance_notifications (user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_notifications_conversation
  ON public.attendance_notifications (conversation_id);

-- -----------------------------------------------------------------------------
-- Internal chat
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.internal_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'group',
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.internal_chats ADD COLUMN IF NOT EXISTS company_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'internal_chats_company_id_fkey'
  ) THEN
    ALTER TABLE public.internal_chats
      ADD CONSTRAINT internal_chats_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_internal_chats_company ON public.internal_chats(company_id);

CREATE TABLE IF NOT EXISTS public.internal_chat_members (
  chat_id UUID NOT NULL REFERENCES public.internal_chats(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_at TIMESTAMPTZ,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.internal_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID NOT NULL REFERENCES public.internal_chats(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.internal_messages ADD COLUMN IF NOT EXISTS attachment_path TEXT;
ALTER TABLE public.internal_messages ADD COLUMN IF NOT EXISTS attachment_mime_type TEXT;
ALTER TABLE public.internal_messages ADD COLUMN IF NOT EXISTS attachment_filename TEXT;
ALTER TABLE public.internal_messages ADD COLUMN IF NOT EXISTS attachment_original_name TEXT;
ALTER TABLE public.internal_messages ADD COLUMN IF NOT EXISTS attachment_size INTEGER;
ALTER TABLE public.internal_messages ADD COLUMN IF NOT EXISTS attachment_type TEXT;

CREATE INDEX IF NOT EXISTS internal_messages_chat_idx
  ON public.internal_messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS public.internal_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES public.internal_chats(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES public.internal_messages(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS internal_notifications_user_idx
  ON public.internal_notifications(user_id, read_at);

-- =============================================================================
-- Fim do schema DEV
-- =============================================================================
