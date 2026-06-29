// Isolamento multitenant por empresa (server-only).
//
// DECISÃO OFICIAL: company_id é a ÚNICA fonte de isolamento de empresa nos
// módulos operacionais (atendimento, contatos, canais, mensagens, usuários
// operacionais, atendentes). tenant_id NÃO separa esses dados.
//
// Regras de segurança (estritas):
//   - usuário sem company_id válido NÃO opera o sistema;
//   - NUNCA cria "Empresa Padrão" automaticamente;
//   - NUNCA auto-atribui empresa a um usuário;
//   - sem empresa válida => 403 (módulos operacionais negam acesso).
//
// NÃO mexe em tenant_id, senha, sessão ou login (isso é feito nos endpoints).
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

let _userCompanyReady: Promise<void> | null = null;

/** Mensagem única exibida quando o usuário não tem empresa válida. */
export const NO_COMPANY_MESSAGE =
  "Usuário sem empresa vinculada. Contate o administrador.";

/**
 * Migração idempotente do vínculo users <-> companies.
 *   - adiciona public.users.company_id (UUID NULL) se não existir
 *   - cria FK users.company_id -> companies(id) (idempotente)
 *   - cria índice de busca por company_id
 *
 * IMPORTANTE: NÃO cria empresa padrão e NÃO faz backfill/auto-atribuição.
 * Isolamento é estrito: usuário sem company_id válido é bloqueado nos
 * módulos operacionais.
 */
export async function ensureUserCompanySchema(): Promise<void> {
  if (_userCompanyReady) return _userCompanyReady;
  _userCompanyReady = (async () => {
    // Garante que a tabela companies exista (criada no schema CRM).
    await ensureCrmSchema();
    const s = sql();

    // Coluna + FK + índice idempotentes. Mantém a FK existente como está
    // (não recriamos para não alterar comportamento de bancos legados).
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

    console.log("[USER_COMPANY_SCHEMA_OK]");
  })().catch((e) => {
    _userCompanyReady = null; // permite nova tentativa
    throw e;
  });
  return _userCompanyReady;
}

export interface CurrentUserCompanyInfo {
  /** Há sessão válida e o usuário existe em public.users. */
  authenticated: boolean;
  /** company_id apenas quando a empresa é válida; caso contrário null. */
  companyId: string | null;
  /** Nome da empresa válida; caso contrário null. */
  companyName: string | null;
  /** true somente quando company_id existe E aponta para empresa existente. */
  companyValid: boolean;
}

/**
 * Resolve a empresa do usuário logado, validando contra public.companies.
 * NUNCA cria empresa padrão e NUNCA auto-atribui empresa.
 */
export async function getCurrentUserCompanyInfo(): Promise<CurrentUserCompanyInfo> {
  const empty: CurrentUserCompanyInfo = {
    authenticated: false,
    companyId: null,
    companyName: null,
    companyValid: false,
  };

  const uid = getSessionUserId();
  if (!uid) return empty;

  await ensureUserCompanySchema();
  const s = sql();
  const rows = await s<
    { company_id: string | null; company_pk: string | null; company_name: string | null }[]
  >`
    SELECT u.company_id,
           c.id   AS company_pk,
           c.name AS company_name
    FROM public.users u
    LEFT JOIN public.companies c ON c.id = u.company_id
    WHERE u.id = ${uid}::uuid
    LIMIT 1
  `;
  if (!rows[0]) return empty;

  const companyValid = !!rows[0].company_pk;
  return {
    authenticated: true,
    companyId: companyValid ? rows[0].company_id : null,
    companyName: companyValid ? rows[0].company_name : null,
    companyValid,
  };
}

/**
 * Empresa do usuário logado (validada). Retorna null quando:
 *   - não há sessão; ou
 *   - o usuário não tem company_id; ou
 *   - o company_id aponta para empresa inexistente.
 * NUNCA cria empresa padrão e NUNCA auto-atribui empresa.
 */
export async function getCurrentUserCompanyId(): Promise<string | null> {
  const info = await getCurrentUserCompanyInfo();
  return info.companyId;
}

/**
 * Helper seguro para handlers de API operacionais.
 * Retorna o companyId (string) quando há empresa válida, ou uma Response
 * pronta (401 sem sessão / 403 sem empresa válida) que o handler deve retornar.
 *
 * Uso:
 *   const company = await requireCompanyId();
 *   if (company instanceof Response) return company;
 *   const companyId = company;
 */
export async function requireCompanyId(): Promise<string | Response> {
  const info = await getCurrentUserCompanyInfo();
  if (!info.authenticated) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!info.companyValid || !info.companyId) {
    return Response.json(
      { error: "no_company", message: NO_COMPANY_MESSAGE },
      { status: 403 },
    );
  }
  return info.companyId;
}
