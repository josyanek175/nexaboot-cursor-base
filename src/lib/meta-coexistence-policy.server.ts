/**
 * Feature flag + autorização Meta Coexistence — server-only.
 * Ausente ou false = comportamento Meta Cloud API tradicional 100% inalterado.
 * Liberação controlada: flag + SUPER_ADMIN/TI + allowlist de company_id.
 * Allowlist vazia = ninguém inicia onboarding (mesmo com flag true).
 */

export function isMetaCoexistenceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.META_COEXISTENCE_ENABLED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/** Somente SUPER_ADMIN ou TI podem operar Embedded Signup / Coexistence. */
export function canManageMetaCoexistence(role: string | null | undefined): boolean {
  const r = String(role ?? "").toUpperCase();
  return r === "SUPER_ADMIN" || r === "TI";
}

/**
 * Parse de META_COEXISTENCE_ALLOWED_COMPANY_IDS (UUIDs separados por vírgula).
 * Vazio / ausente → lista vazia → ninguém autorizado.
 */
export function parseMetaCoexistenceAllowedCompanyIds(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.META_COEXISTENCE_ALLOWED_COMPANY_IDS?.trim() ?? "";
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

/** Empresa na allowlist? Allowlist vazia = false (ninguém). */
export function isCompanyAllowedForMetaCoexistence(
  companyId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const id = String(companyId ?? "")
    .trim()
    .toLowerCase();
  if (!id) return false;
  const allowed = parseMetaCoexistenceAllowedCompanyIds(env);
  if (allowed.length === 0) return false;
  return allowed.includes(id);
}

/**
 * Gate completo de liberação controlada.
 * Ordem: flag → role → allowlist.
 * Retorna Response de erro ou null se autorizado.
 */
export function assertMetaCoexistenceAccess(params: {
  role: string | null | undefined;
  companyId: string | null | undefined;
  env?: NodeJS.ProcessEnv;
}): Response | null {
  const env = params.env ?? process.env;
  if (!isMetaCoexistenceEnabled(env)) {
    return metaCoexistenceDisabledResponse();
  }
  if (!canManageMetaCoexistence(params.role)) {
    return metaCoexistenceForbiddenResponse();
  }
  if (!isCompanyAllowedForMetaCoexistence(params.companyId, env)) {
    return metaCoexistenceCompanyNotAllowlistedResponse();
  }
  return null;
}

/** Resposta padrão quando a flag está desligada (não vaza existência do fluxo). */
export function metaCoexistenceDisabledResponse(): Response {
  return Response.json(
    {
      error: "meta_coexistence_disabled",
      message: "Meta Coexistence não está habilitada neste ambiente.",
    },
    { status: 404 },
  );
}

export function metaCoexistenceForbiddenResponse(): Response {
  return Response.json(
    {
      error: "forbidden",
      message: "Apenas SUPER_ADMIN ou TI podem usar Meta Coexistence.",
    },
    { status: 403 },
  );
}

export function metaCoexistenceCompanyNotAllowlistedResponse(): Response {
  return Response.json(
    {
      error: "company_not_allowlisted",
      message:
        "Esta empresa não está liberada para Meta Coexistence (META_COEXISTENCE_ALLOWED_COMPANY_IDS).",
    },
    { status: 403 },
  );
}

/** Env pública necessária para Embedded Signup (sem secrets / sem allowlist). */
export function getMetaCoexistencePublicConfig(env: NodeJS.ProcessEnv = process.env): {
  appId: string | null;
  configId: string | null;
  graphVersion: string;
  redirectUri: string | null;
} {
  return {
    appId: env.META_APP_ID?.trim() || null,
    configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID?.trim() || null,
    graphVersion: env.META_GRAPH_API_VERSION?.trim() || "v21.0",
    redirectUri: env.META_EMBEDDED_SIGNUP_REDIRECT_URI?.trim() || null,
  };
}
