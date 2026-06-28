// Isolamento multitenant por empresa (server-only).
//
// Resolve a empresa (company_id) do usuário logado para escopar todas as
// queries de atendimento/canais. Idempotente e não destrutivo:
//   - adiciona public.users.company_id (UUID NULL) se não existir
//   - cria FK users.company_id -> companies(id) ON DELETE SET NULL (idempotente)
//   - garante uma "Empresa Padrão" (slug='default') e vincula usuários sem company
//
// NÃO mexe em tenant_id, senha, sessão ou login.
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

let _userCompanyReady: Promise<void> | null = null;

/** Migração idempotente do vínculo users <-> companies. */
export async function ensureUserCompanySchema(): Promise<void> {
  if (_userCompanyReady) return _userCompanyReady;
  _userCompanyReady = (async () => {
    // Garante que a tabela companies exista (criada no schema CRM).
    await ensureCrmSchema();
    const s = sql();

    // Empresa padrão (não destrutivo).
    await s`
      INSERT INTO public.companies (name, slug)
      VALUES ('Empresa Padrão', 'default')
      ON CONFLICT (slug) DO NOTHING
    `;

    // Coluna + FK idempotentes. ON DELETE SET NULL para nunca apagar usuários.
    await s.unsafe(`
      ALTER TABLE public.users ADD COLUMN IF NOT EXISTS company_id UUID;
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
      CREATE INDEX IF NOT EXISTS idx_users_company ON public.users(company_id);
    `);

    // Backfill: vincula usuários sem empresa à Empresa Padrão.
    await s`
      UPDATE public.users
      SET company_id = (SELECT id FROM public.companies WHERE slug = 'default' LIMIT 1),
          updated_at = now()
      WHERE company_id IS NULL
    `;

    console.log("[USER_COMPANY_SCHEMA_OK]");
  })().catch((e) => {
    _userCompanyReady = null; // permite nova tentativa
    throw e;
  });
  return _userCompanyReady;
}

/** Id da Empresa Padrão (cria se necessário). */
export async function getDefaultCompanyId(): Promise<string> {
  await ensureUserCompanySchema();
  const s = sql();
  const rows = await s<{ id: string }[]>`
    SELECT id FROM public.companies WHERE slug = 'default' LIMIT 1
  `;
  if (rows[0]) return rows[0].id;
  const ins = await s<{ id: string }[]>`
    INSERT INTO public.companies (name, slug)
    VALUES ('Empresa Padrão', 'default')
    ON CONFLICT (slug) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  return ins[0].id;
}

/**
 * Empresa do usuário logado. Valida sessão, garante o schema do vínculo e
 * atribui a Empresa Padrão caso o usuário ainda não tenha company_id.
 * Retorna null quando não há sessão válida (caller deve responder 401).
 */
export async function getCurrentUserCompanyId(): Promise<string | null> {
  const uid = getSessionUserId();
  if (!uid) return null;
  await ensureUserCompanySchema();
  const s = sql();
  const rows = await s<{ company_id: string | null }[]>`
    SELECT company_id FROM public.users WHERE id = ${uid}::uuid LIMIT 1
  `;
  if (!rows[0]) return null;
  if (rows[0].company_id) return rows[0].company_id;

  const companyId = await getDefaultCompanyId();
  await s`
    UPDATE public.users SET company_id = ${companyId}::uuid, updated_at = now()
    WHERE id = ${uid}::uuid
  `;
  console.log("[USER_COMPANY_ASSIGNED_DEFAULT]", { userId: uid, companyId });
  return companyId;
}
