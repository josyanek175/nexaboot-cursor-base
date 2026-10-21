// Sessão via cookie httpOnly assinado (HMAC-SHA256).
import { getCookie, setCookie, deleteCookie } from "@tanstack/react-start/server";
import { createHmac, timingSafeEqual } from "crypto";

export const COOKIE_NAME = "nexa_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 dias

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET não configurada");
  return s;
}

/** Diagnóstico: confirma se SESSION_SECRET está disponível em runtime (sem expor o valor). */
export function hasSessionSecret(): boolean {
  return !!process.env.SESSION_SECRET;
}

function cookieIsSecure(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Monta o header Set-Cookie da sessão de forma EXPLÍCITA.
 * Mais confiável que depender do merge de contexto do framework:
 * o header é anexado diretamente na Response da rota.
 */
export function buildSessionSetCookie(userId: string): string {
  const value = createSessionToken(userId);
  const parts = [
    `${COOKIE_NAME}=${value}`,
    `Max-Age=${MAX_AGE}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (cookieIsSecure()) parts.push("Secure");
  return parts.join("; ");
}

/** Header Set-Cookie para limpar a sessão (logout). */
export function buildClearSetCookie(): string {
  const parts = [
    `${COOKIE_NAME}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (cookieIsSecure()) parts.push("Secure");
  return parts.join("; ");
}

/** Diagnóstico dos atributos do cookie (sem expor token/assinatura). */
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
    maxAge: MAX_AGE,
    nodeEnv: process.env.NODE_ENV,
  };
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionToken(userId: string) {
  const payload = `${userId}.${Date.now()}`;
  const b64 = Buffer.from(payload).toString("base64url");
  return `${b64}.${sign(b64)}`;
}

export function verifySessionToken(token: string): string | null {
  try {
    const [b64, sig] = token.split(".");
    if (!b64 || !sig) return null;
    const expected = sign(b64);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = Buffer.from(b64, "base64url").toString();
    const [userId] = payload.split(".");
    return userId || null;
  } catch {
    return null;
  }
}

export function setSessionCookie(userId: string) {
  setCookie(COOKIE_NAME, createSessionToken(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export function clearSessionCookie() {
  deleteCookie(COOKIE_NAME, { path: "/" });
}

export function getSessionUserId(): string | null {
  const t = getCookie(COOKIE_NAME);
  if (!t) return null;
  return verifySessionToken(t);
}
