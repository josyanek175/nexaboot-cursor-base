// Sessão via cookie httpOnly assinado (HMAC-SHA256).
import { getCookie, setCookie, deleteCookie } from "@tanstack/react-start/server";
import { createHmac, timingSafeEqual } from "crypto";

const COOKIE_NAME = "nexa_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 dias

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET não configurada");
  return s;
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
