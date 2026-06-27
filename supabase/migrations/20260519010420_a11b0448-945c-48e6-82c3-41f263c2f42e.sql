
-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM ('ADMIN_GERAL', 'ADMIN_EMPRESA', 'SUPERVISOR', 'ATENDENTE');
CREATE TYPE public.tenant_status AS ENUM ('ativo', 'suspenso', 'inativo');
CREATE TYPE public.tenant_plan AS ENUM ('Free', 'Pro', 'Business');
CREATE TYPE public.channel_provider AS ENUM ('META', 'EVOLUTION', 'INTERNAL');
CREATE TYPE public.channel_status AS ENUM ('connected', 'disconnected', 'pending', 'error');
CREATE TYPE public.conversation_status AS ENUM ('open', 'waiting', 'finished');
CREATE TYPE public.message_direction AS ENUM ('in', 'out');
CREATE TYPE public.message_type AS ENUM ('text', 'image', 'audio', 'document', 'video', 'internal');
CREATE TYPE public.message_delivery_status AS ENUM ('sent', 'delivered', 'read', 'error');

-- ============ TIMESTAMP TRIGGER ============
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ============ TENANTS ============
CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  cnpj TEXT,
  plan public.tenant_plan NOT NULL DEFAULT 'Free',
  status public.tenant_status NOT NULL DEFAULT 'ativo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  email TEXT,
  avatar_url TEXT,
  avatar_color TEXT DEFAULT '#00a884',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ USERS_TENANTS (vínculo) ============
CREATE TABLE public.users_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);

-- ============ USER_ROLES (perfil por empresa) ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id, role)
);
CREATE INDEX idx_user_roles_user ON public.user_roles(user_id);

-- ============ SECURITY DEFINER HELPERS ============
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'ADMIN_GERAL');
$$;

CREATE OR REPLACE FUNCTION public.is_member_of_tenant(_user_id UUID, _tenant_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users_tenants WHERE user_id = _user_id AND tenant_id = _tenant_id
  ) OR public.is_super_admin(_user_id);
$$;

CREATE OR REPLACE FUNCTION public.has_tenant_role(_user_id UUID, _tenant_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
      AND (tenant_id = _tenant_id OR tenant_id IS NULL)
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_tenant(_user_id UUID, _tenant_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_super_admin(_user_id)
      OR public.has_tenant_role(_user_id, _tenant_id, 'ADMIN_EMPRESA');
$$;

CREATE OR REPLACE FUNCTION public.can_view_all_conversations(_user_id UUID, _tenant_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_super_admin(_user_id)
      OR public.has_tenant_role(_user_id, _tenant_id, 'ADMIN_EMPRESA')
      OR public.has_tenant_role(_user_id, _tenant_id, 'SUPERVISOR');
$$;

-- ============ WHATSAPP CHANNELS ============
CREATE TABLE public.whatsapp_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  provider public.channel_provider NOT NULL,
  status public.channel_status NOT NULL DEFAULT 'pending',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_channels_tenant ON public.whatsapp_channels(tenant_id);
CREATE TRIGGER trg_channels_updated BEFORE UPDATE ON public.whatsapp_channels
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ CONTACTS ============
CREATE TABLE public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  notes TEXT,
  avatar_color TEXT DEFAULT '#00a884',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);
CREATE INDEX idx_contacts_tenant ON public.contacts(tenant_id);
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ TAGS ============
CREATE TABLE public.tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#00a884',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE public.contact_tags (
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);

-- ============ CONVERSATIONS ============
CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  status public.conversation_status NOT NULL DEFAULT 'open',
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  unread_count INT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversations_tenant ON public.conversations(tenant_id);
CREATE INDEX idx_conversations_assigned ON public.conversations(assigned_to);
CREATE TRIGGER trg_conversations_updated BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ MESSAGES ============
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  direction public.message_direction NOT NULL,
  type public.message_type NOT NULL,
  body TEXT,
  media_url TEXT,
  file_name TEXT,
  mime_type TEXT,
  file_size BIGINT,
  duration_seconds INT,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  is_internal_note BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_conversation ON public.messages(conversation_id);
CREATE INDEX idx_messages_tenant ON public.messages(tenant_id);

-- ============ MESSAGE STATUS ============
CREATE TABLE public.message_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  status public.message_delivery_status NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_status_msg ON public.message_status(message_id);

-- ============ CONVERSATION ASSIGNMENTS ============
CREATE TABLE public.conversation_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unassigned_at TIMESTAMPTZ
);
CREATE INDEX idx_assignments_conv ON public.conversation_assignments(conversation_id);

-- ============ AUDIT LOGS ============
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant ON public.audit_logs(tenant_id);

-- ============ WEBHOOK LOGS ============
CREATE TABLE public.webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES public.whatsapp_channels(id) ON DELETE SET NULL,
  provider public.channel_provider,
  event_type TEXT,
  status_code INT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_tenant ON public.webhook_logs(tenant_id);

-- ============ ENABLE RLS ============
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;

-- ============ POLICIES: tenants ============
CREATE POLICY "Members view their tenants" ON public.tenants FOR SELECT TO authenticated
  USING (public.is_member_of_tenant(auth.uid(), id));
CREATE POLICY "Super admin manage tenants" ON public.tenants FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid())) WITH CHECK (public.is_super_admin(auth.uid()));
CREATE POLICY "Tenant admin update own tenant" ON public.tenants FOR UPDATE TO authenticated
  USING (public.can_manage_tenant(auth.uid(), id)) WITH CHECK (public.can_manage_tenant(auth.uid(), id));

-- ============ POLICIES: profiles ============
CREATE POLICY "View own profile" ON public.profiles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.users_tenants ut1
      JOIN public.users_tenants ut2 ON ut1.tenant_id = ut2.tenant_id
      WHERE ut1.user_id = auth.uid() AND ut2.user_id = profiles.user_id));
CREATE POLICY "Update own profile" ON public.profiles FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "Insert own profile" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============ POLICIES: users_tenants ============
CREATE POLICY "View own membership" ON public.users_tenants FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.can_manage_tenant(auth.uid(), tenant_id));
CREATE POLICY "Admin manage membership" ON public.users_tenants FOR ALL TO authenticated
  USING (public.can_manage_tenant(auth.uid(), tenant_id))
  WITH CHECK (public.can_manage_tenant(auth.uid(), tenant_id));

-- ============ POLICIES: user_roles ============
CREATE POLICY "View own roles" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.can_manage_tenant(auth.uid(), tenant_id));
CREATE POLICY "Admin manage roles" ON public.user_roles FOR ALL TO authenticated
  USING (public.can_manage_tenant(auth.uid(), tenant_id))
  WITH CHECK (public.can_manage_tenant(auth.uid(), tenant_id));

-- ============ POLICIES: whatsapp_channels ============
CREATE POLICY "Tenant members view channels" ON public.whatsapp_channels FOR SELECT TO authenticated
  USING (public.is_member_of_tenant(auth.uid(), tenant_id));
CREATE POLICY "Admin manage channels" ON public.whatsapp_channels FOR ALL TO authenticated
  USING (public.can_manage_tenant(auth.uid(), tenant_id))
  WITH CHECK (public.can_manage_tenant(auth.uid(), tenant_id));

-- ============ POLICIES: contacts ============
CREATE POLICY "Tenant members view contacts" ON public.contacts FOR SELECT TO authenticated
  USING (public.is_member_of_tenant(auth.uid(), tenant_id));
CREATE POLICY "Tenant members manage contacts" ON public.contacts FOR ALL TO authenticated
  USING (public.is_member_of_tenant(auth.uid(), tenant_id))
  WITH CHECK (public.is_member_of_tenant(auth.uid(), tenant_id));

-- ============ POLICIES: tags ============
CREATE POLICY "Tenant view tags" ON public.tags FOR SELECT TO authenticated
  USING (public.is_member_of_tenant(auth.uid(), tenant_id));
CREATE POLICY "Tenant manage tags" ON public.tags FOR ALL TO authenticated
  USING (public.is_member_of_tenant(auth.uid(), tenant_id))
  WITH CHECK (public.is_member_of_tenant(auth.uid(), tenant_id));

CREATE POLICY "Tenant view contact_tags" ON public.contact_tags FOR SELECT TO authenticated
  USING (public.is_member_of_tenant(auth.uid(), tenant_id));
CREATE POLICY "Tenant manage contact_tags" ON public.contact_tags FOR ALL TO authenticated
  USING (public.is_member_of_tenant(auth.uid(), tenant_id))
  WITH CHECK (public.is_member_of_tenant(auth.uid(), tenant_id));

-- ============ POLICIES: conversations ============
-- ATENDENTE só vê atribuídas; SUPERVISOR/ADMIN vê todas do tenant
CREATE POLICY "View conversations by role" ON public.conversations FOR SELECT TO authenticated
  USING (
    public.is_member_of_tenant(auth.uid(), tenant_id) AND (
      public.can_view_all_conversations(auth.uid(), tenant_id)
      OR assigned_to = auth.uid()
    )
  );
CREATE POLICY "Insert conversations in tenant" ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (public.is_member_of_tenant(auth.uid(), tenant_id));
CREATE POLICY "Update conversations" ON public.conversations FOR UPDATE TO authenticated
  USING (
    public.is_member_of_tenant(auth.uid(), tenant_id) AND (
      public.can_view_all_conversations(auth.uid(), tenant_id)
      OR assigned_to = auth.uid()
    )
  )
  WITH CHECK (public.is_member_of_tenant(auth.uid(), tenant_id));
CREATE POLICY "Admin delete conversations" ON public.conversations FOR DELETE TO authenticated
  USING (public.can_manage_tenant(auth.uid(), tenant_id));

-- ============ POLICIES: messages ============
CREATE POLICY "View messages of viewable conversations" ON public.messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND public.is_member_of_tenant(auth.uid(), c.tenant_id)
      AND (public.can_view_all_conversations(auth.uid(), c.tenant_id) OR c.assigned_to = auth.uid())));
CREATE POLICY "Insert messages in viewable conversations" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND public.is_member_of_tenant(auth.uid(), c.tenant_id)
      AND (public.can_view_all_conversations(auth.uid(), c.tenant_id) OR c.assigned_to = auth.uid())));

-- ============ POLICIES: message_status ============
CREATE POLICY "View message status" ON public.message_status FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.id = message_status.message_id
      AND public.is_member_of_tenant(auth.uid(), c.tenant_id)
      AND (public.can_view_all_conversations(auth.uid(), c.tenant_id) OR c.assigned_to = auth.uid())));
CREATE POLICY "Insert message status" ON public.message_status FOR INSERT TO authenticated
  WITH CHECK (public.is_member_of_tenant(auth.uid(), tenant_id));

-- ============ POLICIES: conversation_assignments ============
CREATE POLICY "View assignments" ON public.conversation_assignments FOR SELECT TO authenticated
  USING (public.is_member_of_tenant(auth.uid(), tenant_id) AND
    (public.can_view_all_conversations(auth.uid(), tenant_id) OR user_id = auth.uid()));
CREATE POLICY "Manage assignments" ON public.conversation_assignments FOR ALL TO authenticated
  USING (public.can_view_all_conversations(auth.uid(), tenant_id))
  WITH CHECK (public.can_view_all_conversations(auth.uid(), tenant_id));

-- ============ POLICIES: audit_logs ============
CREATE POLICY "Admins view audit logs" ON public.audit_logs FOR SELECT TO authenticated
  USING (public.can_manage_tenant(auth.uid(), tenant_id));
CREATE POLICY "System insert audit logs" ON public.audit_logs FOR INSERT TO authenticated
  WITH CHECK (public.is_member_of_tenant(auth.uid(), tenant_id));

-- ============ POLICIES: webhook_logs ============
CREATE POLICY "Admins view webhook logs" ON public.webhook_logs FOR SELECT TO authenticated
  USING (public.can_manage_tenant(auth.uid(), tenant_id));

-- ============ NEW USER PROFILE TRIGGER ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name, email)
  VALUES (NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NEW.email)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
