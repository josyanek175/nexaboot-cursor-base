// Conexão PostgreSQL externa via DATABASE_URL.
// Usa postgres.js. Servidor-only.
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;
let _schemaReady: Promise<void> | null = null;

export function sql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL não configurada");
    _sql = postgres(url, {
      ssl: url.includes("sslmode=require") || url.includes("supabase") || url.includes("neon")
        ? "require"
        : undefined,
      max: 5,
      prepare: false,
    });
  }
  return _sql;
}

// ───────────────────────────────────────────────────────────────────────────
// Schema de Atendimento/CRM (Evolution) — banco principal (nexaboot-postgres).
// Idempotente e NÃO destrutivo: só CREATE TABLE/INDEX IF NOT EXISTS e
// ADD COLUMN IF NOT EXISTS. Não apaga nada, não usa Supabase/RLS.
// Padrão com company_id, conforme o código do webhook/atendimento espera.
// ───────────────────────────────────────────────────────────────────────────
let _crmReady: Promise<void> | null = null;

/**
 * Substitui ON DELETE CASCADE por ON DELETE RESTRICT entre
 * contacts → conversations → messages, SEM jamais apagar dados.
 *
 * Passo defensivo para bancos legados: antes de validar cada FET RESTRICT,
 * trata registros órfãos apenas DESVINCULANDO com NULL (preserva histórico):
 *   - conversations.contact_id órfão  → NULL  (conversa e mensagens mantidas)
 *   - messages.conversation_id órfão  → NULL  (mensagem mantida) — só se a
 *     coluna for nullable. Se for NOT NULL e houver órfãs, NÃO altera (não
 *     apaga, não quebra) e registra log claro para a TI corrigir no banco.
 * Nunca usa DELETE.
 */
async function ensureNoCascadeFks(s: ReturnType<typeof sql>) {
  // ── 1) conversations.contact_id ───────────────────────────────────────────
  const orphanConvs = await s<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM public.conversations c
    WHERE c.contact_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = c.contact_id)
  `;
  const orphanConvCount = Number(orphanConvs[0]?.count ?? 0);
  if (orphanConvCount > 0) {
    console.warn("[CRM_ORPHAN_CONVERSATIONS]", {
      count: orphanConvCount,
      action: "SET contact_id = NULL (conversa e mensagens preservadas; nada apagado)",
    });
    await s`
      UPDATE public.conversations c
      SET contact_id = NULL, updated_at = now()
      WHERE c.contact_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = c.contact_id)
    `;
  }
  await s.unsafe(`
    ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_contact_id_fkey;
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_contact_id_fkey
      FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;
  `);
  console.log("[CRM_FK_RESTRICT_OK]", { fk: "conversations.contact_id", orphansUnlinked: orphanConvCount });

  // ── 2) messages.conversation_id ───────────────────────────────────────────
  const col = await s<{ is_nullable: string }[]>`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'conversation_id'
    LIMIT 1
  `;
  const conversationIdNullable = col[0]?.is_nullable === "YES";

  const orphanMsgs = await s<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM public.messages m
    WHERE m.conversation_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = m.conversation_id)
  `;
  const orphanMsgCount = Number(orphanMsgs[0]?.count ?? 0);

  if (orphanMsgCount > 0 && !conversationIdNullable) {
    // Não apagamos mensagens e não podemos setar NULL → não aplicamos a FK.
    console.error("[CRM_ORPHAN_MESSAGES_BLOCKED]", {
      count: orphanMsgCount,
      reason: "messages.conversation_id é NOT NULL e existem mensagens órfãs.",
      action: "RESTRICT NÃO aplicado (não apaga, não quebra). TI deve corrigir os órfãos no banco.",
    });
    return;
  }

  if (orphanMsgCount > 0) {
    console.warn("[CRM_ORPHAN_MESSAGES]", {
      count: orphanMsgCount,
      action: "SET conversation_id = NULL (mensagem preservada; nada apagado)",
    });
    await s`
      UPDATE public.messages m
      SET conversation_id = NULL
      WHERE m.conversation_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = m.conversation_id)
    `;
  }
  await s.unsafe(`
    ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_conversation_id_fkey;
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_conversation_id_fkey
      FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE RESTRICT;
  `);
  console.log("[CRM_FK_RESTRICT_OK]", { fk: "messages.conversation_id", orphansUnlinked: orphanMsgCount });
}

export async function ensureCrmSchema() {
  if (_crmReady) return _crmReady;
  _crmReady = (async () => {
    const s = sql();
    try {
      await s.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS public.companies (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          slug TEXT UNIQUE,
          active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

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
        CREATE INDEX IF NOT EXISTS idx_channels_type_instance
          ON public.whatsapp_channels(channel_type, evolution_instance_name);

        -- Colunas extras para a tela de gestão de canais (idempotente).
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS phone_number TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS display_name TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

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
        CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_phone_uniq
          ON public.contacts(company_id, phone);
        CREATE INDEX IF NOT EXISTS idx_contacts_company_phone
          ON public.contacts(company_id, phone);

        -- Colunas extras para a tela de Contatos (idempotente, não destrutivo).
        -- O webhook continua gravando só company_id/phone/name/external_jid/contact_type;
        -- estas colunas são opcionais e usadas pelo CRUD manual da tela /contatos.
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS email TEXT;
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS reference TEXT;
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS status TEXT;
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS tags TEXT[];
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS avatar_color TEXT;

        CREATE TABLE IF NOT EXISTS public.conversations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
          -- Regra NexaBoot: contato NUNCA apaga conversas em cascata (RESTRICT).
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

        CREATE TABLE IF NOT EXISTS public.messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          -- Regra NexaBoot: conversa NUNCA apaga mensagens em cascata (RESTRICT).
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
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_messages_external_id ON public.messages(external_id);
        CREATE INDEX IF NOT EXISTS idx_messages_external_message_id ON public.messages(external_message_id);
        CREATE UNIQUE INDEX IF NOT EXISTS messages_conv_extid_uniq
          ON public.messages(conversation_id, external_message_id)
          WHERE external_message_id IS NOT NULL;

        -- Autoria do atendente (Fase 2.2) e reações do WhatsApp. Idempotente e
        -- não destrutivo: mensagens antigas ficam com estes campos NULL.
        ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS sent_by_user_id UUID;
        ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS sent_by_name TEXT;
        ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reaction_emoji TEXT;
        ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reaction_to_message_id TEXT;
      `);

      // ── Regra de segurança NexaBoot: proibido apagar em cascata ──
      // Troca CASCADE por RESTRICT entre contacts→conversations→messages.
      // Antes de validar cada FK, trata órfãos legados sem apagar nada
      // (apenas desvincula com NULL), evitando que o deploy quebre.
      await ensureNoCascadeFks(s);

      console.log("[CRM_SCHEMA_OK]");
    } catch (e) {
      const err = e as { message?: string; code?: string; detail?: string };
      console.error("[CRM_SCHEMA_FAIL]", { message: err.message, code: err.code, detail: err.detail });
      _crmReady = null; // permite nova tentativa
      throw e;
    }
  })();
  return _crmReady;
}

export async function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const s = sql();
    console.log("[SCHEMA_MIGRATION_START]");

    try {
      // 1) Extensão pgcrypto
      await s.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

      // 2) Tabela users — cria se não existir (sem destruir nada)
      await s.unsafe(`
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
      `);

      // 3) Migração idempotente para bancos legados (não destrutiva)
      await s.unsafe(`
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

        ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_email_key;

        CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_unique
          ON public.users (tenant_id, email);
        CREATE INDEX IF NOT EXISTS idx_users_tenant
          ON public.users (tenant_id);
      `);

      // 3.1) Tabela tenants (id TEXT para compatibilidade com tenant_id atual)
      await s.unsafe(`
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
      `);

      // 4) Verifica leitura das colunas esperadas
      const probe = await s`
        SELECT id, tenant_id, name, email, role, active, created_at
        FROM public.users
        LIMIT 1
      `;
      console.log("[SCHEMA_MIGRATION_OK]", {
        usersTable: "public.users",
        sampleCount: probe.length,
      });

    } catch (e) {
      const err = e as { message?: string; code?: string; detail?: string };
      console.error("[SCHEMA_MIGRATION_FAIL]", {
        message: err.message,
        code: err.code,
        detail: err.detail,
      });
      throw e;
    }

    // 2) Tabelas de chat interno — recria se schema antigo estiver incompatível.
    //    Como ainda não há dados de produção, dropamos e recriamos para garantir
    //    colunas/chaves corretas (chat_id, sender_id, etc.).
    try {
      const cols = await s`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'internal_messages'
      `;
      const hasChatId = cols.some((c) => c.column_name === "chat_id");
      if (cols.length > 0 && !hasChatId) {
        await s.unsafe(`
          DROP TABLE IF EXISTS internal_notifications CASCADE;
          DROP TABLE IF EXISTS internal_messages CASCADE;
          DROP TABLE IF EXISTS internal_chat_members CASCADE;
          DROP TABLE IF EXISTS internal_chats CASCADE;
        `);
      }
    } catch (e) {
      console.warn("[ensureSchema] introspecção falhou, continuando:", (e as Error).message);
    }

    try {
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS internal_chats (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id TEXT,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'group',
          created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS internal_chat_members (
          chat_id UUID NOT NULL REFERENCES internal_chats(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_read_at TIMESTAMPTZ,
          PRIMARY KEY (chat_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS internal_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          chat_id UUID NOT NULL REFERENCES internal_chats(id) ON DELETE CASCADE,
          sender_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS internal_messages_chat_idx ON internal_messages(chat_id, created_at);

        -- Anexos (arquivos salvos em disco/volume; banco guarda só metadados + caminho).
        -- Idempotente e não destrutivo: não remove nem altera mensagens existentes.
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_path TEXT;
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_mime_type TEXT;
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_filename TEXT;
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_original_name TEXT;
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_size INTEGER;
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_type TEXT;

        CREATE TABLE IF NOT EXISTS internal_notifications (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          chat_id UUID NOT NULL REFERENCES internal_chats(id) ON DELETE CASCADE,
          message_id UUID NOT NULL REFERENCES internal_messages(id) ON DELETE CASCADE,
          read_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS internal_notifications_user_idx ON internal_notifications(user_id, read_at);
      `);
      console.log("[SCHEMA_CHAT_OK]");
    } catch (e) {
      const err = e as { message?: string; code?: string; detail?: string };
      console.error("[SCHEMA_CHAT_FAIL_IGNORED]", {
        message: err.message,
        code: err.code,
        detail: err.detail,
      });
      // não propaga — não queremos quebrar login/auth por causa do chat interno
    }
  })().catch((e) => {
    // Permite nova tentativa em chamadas futuras se falhar
    _schemaReady = null;
    throw e;
  });
  return _schemaReady;
}
