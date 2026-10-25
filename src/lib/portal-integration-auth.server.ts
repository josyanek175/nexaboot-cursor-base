import { createHmac, timingSafeEqual } from "node:crypto";

const seen = new Map<string, number>();
export function verifyPortalRequest(
  request: Request,
  body: string,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (!secret || secret.length < 32) return false;
  const timestamp = request.headers.get("x-nexa-timestamp") ?? "";
  const nonce = request.headers.get("x-nexa-nonce") ?? "";
  const signature = request.headers.get("x-nexa-signature") ?? "";
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 60000 ||
    !/^[a-f0-9-]{36}$/i.test(nonce) ||
    !/^[a-f0-9]{64}$/i.test(signature)
  )
    return false;
  const url = new URL(request.url);
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}\n${nonce}\n${request.method}\n${url.pathname}\n${body}`)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return false;
  for (const [key, expires] of seen) if (expires < now) seen.delete(key);
  if (seen.has(nonce) || seen.size >= 10000) return false;
  seen.set(nonce, now + 120000);
  return true;
}
