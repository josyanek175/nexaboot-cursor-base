// Empresa operacional selecionada por perfis de plataforma (cookie assinado).
import { getCookie } from "@tanstack/react-start/server";
import { createHmac, timingSafeEqual } from "crypto";

export const OPERATIONAL_COMPANY_COOKIE = "nexa_operational_company";
const MAX_AGE = 60 * 60 * 24 * 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET não configurada");
  return s;
}

function cookieIsSecure(): boolean {
  return process.env.NODE_ENV === "production";
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Payload assinado: userId.companyId (ambos UUID). */
export function buildOperationalCompanySetCookie(userId: string, companyId: string): string {
  const payload = `${userId}.${companyId}`;
  const b64 = Buffer.from(payload).toString("base64url");
  const token = `${b64}.${sign(b64)}`;
  const parts = [
    `${OPERATIONAL_COMPANY_COOKIE}=${token}`,
    `Max-Age=${MAX_AGE}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (cookieIsSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function buildOperationalCompanyClearCookie(): string {
  const parts = [
    `${OPERATIONAL_COMPANY_COOKIE}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (cookieIsSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function getOperationalCompanyIdFromCookie(userId: string): string | null {
  const token = getCookie(OPERATIONAL_COMPANY_COOKIE);
  if (!token) return null;
  try {
    const [b64, sig] = token.split(".");
    if (!b64 || !sig) return null;
    const expected = sign(b64);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = Buffer.from(b64, "base64url").toString();
    const [cookieUserId, companyId] = payload.split(".");
    if (cookieUserId !== userId || !companyId) return null;
    return companyId;
  } catch {
    return null;
  }
}
