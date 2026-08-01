/**
 * Feature flag + autorização Meta Coexistence — server-only.
 * Ausente ou false = comportamento Meta Cloud API tradicional 100% inalterado.
 * Sem path-alias para permitir testes Node diretos.
 */

export function isMetaCoexistenceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.META_COEXISTENCE_ENABLED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/** Administradores autorizados a iniciar Embedded Signup (Coexistence). */
export function canManageMetaCoexistence(role: string | null | undefined): boolean {
  const r = String(role ?? "").toUpperCase();
  return (
    r === "SUPER_ADMIN" ||
    r === "TI" ||
    r === "ADMIN_GERAL" ||
    r === "ADMIN_EMPRESA" ||
    r === "ADMIN"
  );
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
      message: "Apenas administradores autorizados podem usar Meta Coexistence.",
    },
    { status: 403 },
  );
}

/** Env pública necessária para Embedded Signup (sem secrets). */
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
