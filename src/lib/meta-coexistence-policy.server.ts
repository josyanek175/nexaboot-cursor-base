/**
 * Feature flag + autorização Meta Coexistence — server-only.
 * Ausente ou false = comportamento Meta Cloud API tradicional 100% inalterado.
 * Liberação controlada: flag + SUPER_ADMIN/TI/ADMIN_EMPRESA + allowlist de company_id.
 * Allowlist vazia = ninguém inicia onboarding (mesmo com flag true).
 *
 * ADMIN_EMPRESA opera somente a empresa da sessão (nunca company_id arbitrário do body).
 */

export function isMetaCoexistenceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.META_COEXISTENCE_ENABLED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/** SUPER_ADMIN, TI ou ADMIN_EMPRESA podem operar Embedded Signup / Coexistence. */
export function canManageMetaCoexistence(role: string | null | undefined): boolean {
  const r = String(role ?? "").toUpperCase();
  return r === "SUPER_ADMIN" || r === "TI" || r === "ADMIN_EMPRESA";
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
 * Extrai company_id / companyId de body JSON ou query (se presente).
 * Não valida existência — só leitura tipada.
 */
export function extractRequestedCompanyId(
  source: unknown,
): string | null {
  if (source == null) return null;
  if (typeof source === "string") {
    const t = source.trim();
    return t || null;
  }
  if (typeof source !== "object" || Array.isArray(source)) return null;
  const rec = source as Record<string, unknown>;
  const raw = rec.company_id ?? rec.companyId;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t || null;
}

/**
 * Impede company_id arbitrário no request.
 * ADMIN_EMPRESA (e demais roles do fluxo): só a empresa da sessão.
 * Se o cliente enviar outro company_id → 403.
 * Se omitir ou repetir a sessão → ok (operação usa sempre sessionCompanyId).
 */
export function assertMetaCoexistenceCompanyScope(params: {
  role: string | null | undefined;
  sessionCompanyId: string;
  requestedCompanyId?: string | null | undefined;
}): Response | null {
  const session = String(params.sessionCompanyId ?? "")
    .trim()
    .toLowerCase();
  if (!session) {
    return Response.json(
      {
        error: "no_company",
        message: "Empresa da sessão inválida para Meta Coexistence.",
      },
      { status: 403 },
    );
  }

  const requested = String(params.requestedCompanyId ?? "")
    .trim()
    .toLowerCase();
  if (!requested) return null;
  if (requested === session) return null;

  return metaCoexistenceCompanyScopeForbiddenResponse();
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

/**
 * Gate + escopo de empresa (sessão vs request).
 * Sempre opera com sessionCompanyId quando autorizado.
 */
export function assertMetaCoexistenceAccessWithScope(params: {
  role: string | null | undefined;
  sessionCompanyId: string;
  requestedCompanyId?: string | null | undefined;
  env?: NodeJS.ProcessEnv;
}): Response | null {
  const scope = assertMetaCoexistenceCompanyScope({
    role: params.role,
    sessionCompanyId: params.sessionCompanyId,
    requestedCompanyId: params.requestedCompanyId,
  });
  if (scope) return scope;
  return assertMetaCoexistenceAccess({
    role: params.role,
    companyId: params.sessionCompanyId,
    env: params.env,
  });
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
      message:
        "Apenas SUPER_ADMIN, TI ou ADMIN_EMPRESA podem usar Meta Coexistence.",
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

export function metaCoexistenceCompanyScopeForbiddenResponse(): Response {
  return Response.json(
    {
      error: "forbidden_company_scope",
      message:
        "Não é permitido operar Meta Coexistence para outra empresa. Use a empresa da sessão.",
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
