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
import { isPlatformRole } from "@/lib/platform-roles";
import { getOperationalCompanyIdFromCookie } from "@/lib/operational-company.server";

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
  /** ID do usuário quando autenticado. */
  userId: string | null;
  /** Role do usuário (quando autenticado). */
  role: string | null;
  /** company_id apenas quando a empresa é válida; caso contrário null. */
  companyId: string | null;
  /** Nome da empresa válida; caso contrário null. */
  companyName: string | null;
  /** true somente quando company_id existe E aponta para empresa existente. */
  companyValid: boolean;
}

export const PLATFORM_NO_COMPANY_MESSAGE =
  "Selecione uma empresa para gerenciar campanhas.";

/**
 * Resolve a empresa do usuário logado, validando contra public.companies.
 * Passe `userId` quando a sessão já foi lida (evita reler o cookie na mesma request).
 */
export async function getCurrentUserCompanyInfo(
  userId?: string | null,
): Promise<CurrentUserCompanyInfo> {
  const empty: CurrentUserCompanyInfo = {
    authenticated: false,
    userId: null,
    role: null,
    companyId: null,
    companyName: null,
    companyValid: false,
  };

  const uid = userId ?? getSessionUserId();
  if (!uid) return empty;

  // Cookie/sessão resolvida: autenticado na camada de sessão (igual /api/auth/me).
  const sessionBase: CurrentUserCompanyInfo = {
    authenticated: true,
    userId: uid,
    role: null,
    companyId: null,
    companyName: null,
    companyValid: false,
  };

  await ensureUserCompanySchema();
  await ensureCrmSchema();
  const s = sql();

  const users = await s<{ id: string; role: string; company_id: string | null }[]>`
    SELECT id, role, company_id FROM public.users WHERE id = ${uid} LIMIT 1
  `;
  if (!users[0]) {
    return sessionBase;
  }

  const user = users[0];
  const platform = isPlatformRole(user.role);

  if (platform) {
    const selectedId = getOperationalCompanyIdFromCookie(uid);
    if (!selectedId) {
      return {
        authenticated: true,
        userId: uid,
        role: user.role,
        companyId: null,
        companyName: null,
        companyValid: false,
      };
    }
    const companies = await s<{ id: string; name: string }[]>`
      SELECT id, name FROM public.companies
      WHERE id = ${selectedId}::uuid AND active = true
      LIMIT 1
    `;
    if (!companies[0]) {
      return {
        authenticated: true,
        userId: uid,
        role: user.role,
        companyId: null,
        companyName: null,
        companyValid: false,
      };
    }
    return {
      authenticated: true,
      userId: uid,
      role: user.role,
      companyId: companies[0].id,
      companyName: companies[0].name,
      companyValid: true,
    };
  }

  const rows = await s<
    { company_id: string | null; company_pk: string | null; company_name: string | null }[]
  >`
    SELECT u.company_id,
           c.id   AS company_pk,
           c.name AS company_name
    FROM public.users u
    LEFT JOIN public.companies c ON c.id = u.company_id AND c.active = true
    WHERE u.id = ${uid}
    LIMIT 1
  `;
  if (!rows[0]) {
    return {
      authenticated: true,
      userId: uid,
      role: user.role,
      companyId: null,
      companyName: null,
      companyValid: false,
    };
  }

  const companyValid = !!rows[0].company_pk;
  return {
    authenticated: true,
    userId: uid,
    role: user.role,
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
export async function requireCompanyId(userId?: string | null): Promise<string | Response> {
  const uid = userId ?? getSessionUserId();
  if (!uid) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const info = await getCurrentUserCompanyInfo(uid);
  if (!info.companyValid || !info.companyId) {
    const platform = isPlatformRole(info.role);
    return Response.json(
      {
        error: "no_company",
        message: platform ? PLATFORM_NO_COMPANY_MESSAGE : NO_COMPANY_MESSAGE,
      },
      { status: 403 },
    );
  }
  return info.companyId;
}
