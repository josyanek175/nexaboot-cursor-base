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
