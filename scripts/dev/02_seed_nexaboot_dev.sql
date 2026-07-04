-- =============================================================================
-- NexaBoot — Seed mínimo para banco DEV
-- Banco alvo: nexaboot_dev
--
-- Pré-requisito: rodar 01_schema_nexaboot_dev.sql antes.
-- Idempotente: pode rodar mais de uma vez (ON CONFLICT / WHERE NOT EXISTS).
-- NÃO inclui dados reais de cliente. NÃO executar em produção.
-- =============================================================================
--
-- Login DEV:
--   email: josyanek175@gmail.com
--   senha: Dev@NexaBoot2026
--
-- Hash gerado no PostgreSQL com pgcrypto (bf/bcrypt), compatível com bcryptjs
-- do app (bcrypt.compare no login).
-- =============================================================================

DO $$
DECLARE
  v_company_id UUID;
  v_user_id UUID;
  v_plan_id UUID;
  v_channel_id UUID;
  v_password_hash TEXT;
BEGIN
  -- Senha DEV (bcrypt via pgcrypto)
  v_password_hash := crypt('Dev@NexaBoot2026', gen_salt('bf', 10));

  -- -------------------------------------------------------------------------
  -- Empresa DEV Teste
  -- -------------------------------------------------------------------------
  SELECT id INTO v_company_id
  FROM public.companies
  WHERE name = 'DEV Teste'
  LIMIT 1;

  IF v_company_id IS NULL THEN
    INSERT INTO public.companies (name, active)
    VALUES ('DEV Teste', true)
    RETURNING id INTO v_company_id;
  ELSE
    UPDATE public.companies
    SET active = true, updated_at = now()
    WHERE id = v_company_id;
  END IF;

  -- -------------------------------------------------------------------------
  -- Plano + assinatura (PRATA — 5 canais, suficiente para DEV)
  -- -------------------------------------------------------------------------
  SELECT id INTO v_plan_id
  FROM public.plans
  WHERE code = 'PRATA'
  LIMIT 1;

  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'Plano PRATA não encontrado. Rode 01_schema_nexaboot_dev.sql antes.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.company_subscriptions
    WHERE company_id = v_company_id AND status = 'active'
  ) THEN
    INSERT INTO public.company_subscriptions (company_id, plan_id, status)
    VALUES (v_company_id, v_plan_id, 'active');
  END IF;

  -- -------------------------------------------------------------------------
  -- Usuário ADMIN_EMPRESA
  -- -------------------------------------------------------------------------
  SELECT id INTO v_user_id
  FROM public.users
  WHERE lower(email) = lower('josyanek175@gmail.com')
  LIMIT 1;

  IF v_user_id IS NULL THEN
    INSERT INTO public.users (
      email, password_hash, name, role, tenant_id, company_id, active
    ) VALUES (
      'josyanek175@gmail.com',
      v_password_hash,
      'Josyane DEV',
      'ADMIN_EMPRESA',
      'default',
      v_company_id,
      true
    )
    RETURNING id INTO v_user_id;
  ELSE
    UPDATE public.users
    SET
      password_hash = v_password_hash,
      name = COALESCE(NULLIF(name, ''), 'Josyane DEV'),
      role = 'ADMIN_EMPRESA',
      tenant_id = COALESCE(tenant_id, 'default'),
      company_id = v_company_id,
      active = true,
      updated_at = now()
    WHERE id = v_user_id;
  END IF;

  -- -------------------------------------------------------------------------
  -- Canal WhatsApp DEV (Evolution)
  -- -------------------------------------------------------------------------
  SELECT id INTO v_channel_id
  FROM public.whatsapp_channels
  WHERE company_id = v_company_id
    AND evolution_instance_name = 'nexaboot-dev-teste'
  LIMIT 1;

  IF v_channel_id IS NULL THEN
    INSERT INTO public.whatsapp_channels (
      company_id,
      name,
      channel_type,
      evolution_instance_name,
      status,
      active,
      display_name,
      last_connected_at
    ) VALUES (
      v_company_id,
      'WhatsApp DEV Teste',
      'evolution',
      'nexaboot-dev-teste',
      'connected',
      true,
      'WhatsApp DEV Teste',
      now()
    )
    RETURNING id INTO v_channel_id;
  ELSE
    UPDATE public.whatsapp_channels
    SET
      name = 'WhatsApp DEV Teste',
      channel_type = 'evolution',
      status = 'connected',
      active = true,
      deleted_at = NULL,
      display_name = 'WhatsApp DEV Teste',
      last_connected_at = now(),
      updated_at = now()
    WHERE id = v_channel_id;
  END IF;

  RAISE NOTICE 'SEED DEV OK';
  RAISE NOTICE 'company_id = %', v_company_id;
  RAISE NOTICE 'user_id    = %', v_user_id;
  RAISE NOTICE 'channel_id = %', v_channel_id;
  RAISE NOTICE 'login      = josyanek175@gmail.com / Dev@NexaBoot2026';
END $$;

-- Conferência rápida (rode após o seed)
SELECT 'companies' AS tabela, count(*)::int AS qtd FROM public.companies
UNION ALL SELECT 'users', count(*)::int FROM public.users
UNION ALL SELECT 'plans', count(*)::int FROM public.plans
UNION ALL SELECT 'company_subscriptions', count(*)::int FROM public.company_subscriptions
UNION ALL SELECT 'whatsapp_channels', count(*)::int FROM public.whatsapp_channels
UNION ALL SELECT 'contacts', count(*)::int FROM public.contacts
UNION ALL SELECT 'conversations', count(*)::int FROM public.conversations
UNION ALL SELECT 'messages', count(*)::int FROM public.messages
UNION ALL SELECT 'campaigns', count(*)::int FROM public.campaigns
UNION ALL SELECT 'conversation_assignments', count(*)::int FROM public.conversation_assignments
UNION ALL SELECT 'attendance_notifications', count(*)::int FROM public.attendance_notifications
ORDER BY 1;

SELECT
  u.id AS user_id,
  u.email,
  u.role,
  u.active,
  c.id AS company_id,
  c.name AS company_name,
  ch.id AS channel_id,
  ch.name AS channel_name,
  ch.evolution_instance_name,
  ch.status AS channel_status
FROM public.users u
JOIN public.companies c ON c.id = u.company_id
LEFT JOIN public.whatsapp_channels ch
  ON ch.company_id = c.id
 AND ch.evolution_instance_name = 'nexaboot-dev-teste'
WHERE lower(u.email) = lower('josyanek175@gmail.com');
