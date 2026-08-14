// Sessão server-side persistida (public.user_sessions).
// Cookie httpOnly carrega token aleatório; o banco guarda só SHA-256.
import { getCookie, setCookie, deleteCookie } from "@tanstack/react-start/server";
import { createHash, randomBytes } from "crypto";
import { sql } from "@/lib/pg.server";
import {
  SESSION_REPLACED_ERROR,
  SESSION_REPLACED_MESSAGE,
} from "@/lib/session-errors";

export const COOKIE_NAME = "nexa_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 dias
const TOKEN_BYTES = 32;

export { SESSION_REPLACED_ERROR, SESSION_REPLACED_MESSAGE };

export type SessionRevokeReason = "replaced_by_new_login" | "logout" | "expired" | "user_inactive";

export type ResolvedSession = {
  sessionId: string;
  userId: string;
  companyId: string | null;
  expiresAt: Date;
};

export type SessionResolveResult =
  | { status: "ok"; session: ResolvedSession }
  | { status: "none" }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "revoked" }
  | { status: "replaced" }
  | { status: "user_inactive" };

function secretConfigured(): boolean {
  return !!process.env.SESSION_SECRET;
}

/** Diagnóstico: confirma se SESSION_SECRET está disponível (sem expor o valor). */
export function hasSessionSecret(): boolean {
  return secretConfigured();
}

function cookieIsSecure(): boolean {
  return process.env.NODE_ENV === "production";
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function cookieParts(value: string, maxAge: number): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (cookieIsSecure()) parts.push("Secure");
  return parts.join("; ");
}

/** Header Set-Cookie da sessão (token opaco). Nunca logar o valor. */
export function buildSessionSetCookie(token: string): string {
  return cookieParts(token, SESSION_MAX_AGE_SEC);
}

/** Header Set-Cookie para limpar a sessão (logout / inválida). */
export function buildClearSetCookie(): string {
  return cookieParts("", 0);
}

export function describeSessionCookie(): {
  name: string;
  httpOnly: true;
  sameSite: "Lax";
  secure: boolean;
  path: "/";
  maxAge: number;
  nodeEnv: string | undefined;
} {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    sameSite: "Lax",
    secure: cookieIsSecure(),
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
    nodeEnv: process.env.NODE_ENV,
  };
}

export function setSessionCookie(token: string) {
  setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieIsSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

export function clearSessionCookie() {
  deleteCookie(COOKIE_NAME, { path: "/" });
}

export function readSessionCookie(): string | null {
  const t = getCookie(COOKIE_NAME);
  if (!t || !t.trim()) return null;
  return t.trim();
}

function parseClientIp(request?: Request | null): string | null {
  if (!request) return null;
  const fwd = request.headers.get("x-forwarded-for");
  const raw =
    fwd?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    null;
  if (!raw || raw.length > 45) return null;
  if (!/^[\d.a-fA-F:]+$/.test(raw)) return null;
  return raw;
}

function parseUserAgent(request?: Request | null): string | null {
  if (!request) return null;
  const ua = request.headers.get("user-agent");
  if (!ua) return null;
  return ua.slice(0, 512);
}

type SessionRow = {
  id: string;
  user_id: string;
  company_id: string | null;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
  user_active: boolean | null;
};

/**
 * Resolve a sessão do cookie (leitura simples, sem transação / FOR UPDATE).
 * Não loga token nem hash.
 */
export async function resolveSession(): Promise<SessionResolveResult> {
  const token = readSessionCookie();
  if (!token) return { status: "none" };

  const tokenHash = hashSessionToken(token);
  const s = sql();

  let rows: SessionRow[];
  try {
    rows = (await s`
      SELECT
        us.id,
        us.user_id,
        us.company_id,
        us.expires_at,
        us.revoked_at,
        us.revoked_reason,
        u.active AS user_active
      FROM public.user_sessions us
      LEFT JOIN public.users u ON u.id = us.user_id
      WHERE us.token_hash = ${tokenHash}
      LIMIT 1
    `) as SessionRow[];
  } catch (e) {
    console.error("[SESSION_LOOKUP_FAIL]", {
      message: e instanceof Error ? e.message : String(e),
    });
    return { status: "invalid" };
  }

  const row = rows[0];
  if (!row) return { status: "invalid" };

  if (row.revoked_at != null) {
    if (row.revoked_reason === "replaced_by_new_login") return { status: "replaced" };
    return { status: "revoked" };
  }

  const expiresAt = new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return { status: "expired" };
  }

  if (!row.user_id || row.user_active === false) {
    return { status: "user_inactive" };
  }

  return {
    status: "ok",
    session: {
      sessionId: String(row.id),
      userId: String(row.user_id),
      companyId: row.company_id != null ? String(row.company_id) : null,
      expiresAt,
    },
  };
}

/** userId da sessão ativa, ou null. */
export async function getSessionUserId(): Promise<string | null> {
  const resolved = await resolveSession();
  return resolved.status === "ok" ? resolved.session.userId : null;
}

export function sessionUnauthorizedResponse(
  resolved: SessionResolveResult,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  if (!headers.has("Set-Cookie")) {
    headers.append("Set-Cookie", buildClearSetCookie());
  }

  if (resolved.status === "replaced") {
    return Response.json(
      { error: SESSION_REPLACED_ERROR, message: SESSION_REPLACED_MESSAGE },
      { status: 401, headers },
    );
  }

  if (resolved.status === "user_inactive") {
    return Response.json(
      { error: "user_inactive", message: "Usuário inativo. Procure o administrador." },
      { status: 401, headers },
    );
  }

  if (resolved.status === "expired") {
    return Response.json(
      { error: "session_expired", message: "Sessão expirada. Faça login novamente." },
      { status: 401, headers },
    );
  }

  return Response.json({ error: "unauthenticated" }, { status: 401, headers });
}

/**
 * Helper central: cookie válido → sessão ativa + usuário ativo.
 * Inválida → 401 (+ Set-Cookie clear) com código identificável.
 */
export async function requireSession(): Promise<ResolvedSession | Response> {
  const resolved = await resolveSession();
  if (resolved.status === "ok") return resolved.session;
  return sessionUnauthorizedResponse(resolved);
}

export async function createPersistedSession(opts: {
  userId: string;
  companyId?: string | null;
  request?: Request | null;
}): Promise<{ sessionId: string; token: string }> {
  if (!secretConfigured()) {
    throw new Error("SESSION_SECRET não configurada");
  }

  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const ip = parseClientIp(opts.request);
  const userAgent = parseUserAgent(opts.request);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SEC * 1000);
  const s = sql();

  const inserted = await s.begin(async (tx) => {
    await tx`
      UPDATE public.user_sessions
      SET revoked_at = now(),
          revoked_reason = 'replaced_by_new_login'
      WHERE user_id = ${opts.userId}::uuid
        AND revoked_at IS NULL
    `;

    const rows = await tx<{ id: string }[]>`
      INSERT INTO public.user_sessions (
        user_id, company_id, token_hash, expires_at, ip, user_agent
      ) VALUES (
        ${opts.userId}::uuid,
        ${opts.companyId ?? null},
        ${tokenHash},
        ${expiresAt},
        ${ip},
        ${userAgent}
      )
      RETURNING id
    `;
    return rows[0];
  });

  if (!inserted?.id) {
    throw new Error("session_insert_failed");
  }

  return { sessionId: inserted.id, token };
}

export async function revokeSessionByCookie(reason: SessionRevokeReason): Promise<void> {
  const token = readSessionCookie();
  if (!token) return;
  const tokenHash = hashSessionToken(token);
  const s = sql();
  try {
    await s`
      UPDATE public.user_sessions
      SET revoked_at = now(),
          revoked_reason = ${reason}
      WHERE token_hash = ${tokenHash}
        AND revoked_at IS NULL
    `;
  } catch (e) {
    console.warn("[SESSION_REVOKE_FAIL]", {
      reason,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
