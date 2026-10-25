import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { getSql } from "@/lib/pg.server";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const RESET_RESPONSE = {
  ok: true,
  message: "Se o e-mail estiver cadastrado, você receberá as instruções de recuperação.",
};

export function recoveryMailConfig() {
  const host = process.env.SMTP_HOST?.trim(),
    user = process.env.SMTP_USER,
    pass = process.env.SMTP_PASSWORD,
    from = process.env.SMTP_FROM?.trim();
  const port = Number(process.env.SMTP_PORT ?? 587);
  const base = new URL(process.env.APP_PUBLIC_URL ?? "");
  if (
    !host ||
    !user ||
    !pass ||
    !from ||
    /[\r\n]/.test(from) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    base.protocol !== "https:" ||
    base.username ||
    base.password
  )
    throw Error("recovery_not_configured");
  return {
    host,
    port,
    auth: { user, pass },
    secure: port === 465,
    requireTLS: port !== 465,
    from,
    base,
  };
}
export async function requestRecovery(email: string) {
  const config = recoveryMailConfig();
  const db = getSql();
  const users =
    await db`SELECT id FROM public.users WHERE lower(email)=${email.trim().toLowerCase()} AND active=true LIMIT 10`;
  for (const user of users) {
    const token = randomBytes(32).toString("hex"),
      tokenHash = digest(token);
    const issued = await db.begin(async (tx) => {
      const locked =
        await tx`SELECT id,name,email,password_hash FROM public.users WHERE id=${user.id}::uuid AND active=true FOR UPDATE`;
      if (!locked[0]) return null;
      const recent =
        await tx`SELECT count(*)::int AS count FROM public.password_reset_tokens WHERE user_id=${user.id}::uuid AND created_at>now()-interval '1 hour'`;
      if (Number(recent[0]?.count ?? 0) >= 3) return null;
      await tx`UPDATE public.password_reset_tokens SET used_at=now() WHERE user_id=${user.id}::uuid AND used_at IS NULL`;
      await tx`INSERT INTO public.password_reset_tokens(user_id,token_hash,credential_hash,expires_at)
        VALUES(${user.id}::uuid,${tokenHash},${digest(locked[0].password_hash ?? "")},now()+interval '30 minutes')`;
      return locked[0];
    });
    if (!issued) continue;
    // Fragment keeps the token out of access logs and HTTP referrers.
    const link = new URL("/redefinir-senha", config.base);
    link.hash = token;
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTLS,
      auth: config.auth,
      connectionTimeout: 10000,
      socketTimeout: 15000,
    });
    try {
      await transporter.sendMail({
        from: config.from,
        to: issued.email,
        subject: "Redefinição de senha — NexaBoot",
        text: `Olá, ${issued.name ?? ""}.\n\nUse o link abaixo para escolher uma nova senha. Ele vale por 30 minutos e pode ser usado uma única vez.\n\n${link.toString()}\n\nSe você não solicitou esta alteração, ignore este e-mail. Sua senha permanece a mesma.`,
      });
    } catch (error) {
      await db`UPDATE public.password_reset_tokens SET used_at=now() WHERE token_hash=${tokenHash}`;
      console.error("[PASSWORD_RECOVERY_DELIVERY_FAILED]", {
        userId: user.id,
        code: (error as { code?: string }).code ?? "smtp_delivery_failed",
      });
    } finally {
      transporter.close();
    }
  }
  return RESET_RESPONSE;
}
export async function consumeRecovery(token: string, password: string) {
  if (
    !/^[a-f0-9]{64}$/.test(token) ||
    password.length < 10 ||
    Buffer.byteLength(password, "utf8") > 72
  )
    return false;
  const db = getSql(),
    hash = digest(token);
  return db.begin(async (tx) => {
    // Lock user before token, matching request issuance order and preventing deadlocks.
    const references =
      await tx`SELECT user_id FROM public.password_reset_tokens WHERE token_hash=${hash} AND used_at IS NULL AND expires_at>now()`;
    if (!references[0]) return false;
    const users =
      await tx`SELECT id,password_hash FROM public.users WHERE id=${references[0].user_id}::uuid AND active=true FOR UPDATE`;
    if (!users[0]) return false;
    const tokens =
      await tx`SELECT id,credential_hash FROM public.password_reset_tokens WHERE token_hash=${hash} AND used_at IS NULL AND expires_at>now() FOR UPDATE`;
    if (!tokens[0] || tokens[0].credential_hash !== digest(users[0].password_hash ?? ""))
      return false;
    const passwordHash = await bcrypt.hash(password, 12);
    await tx`UPDATE public.users SET password_hash=${passwordHash},updated_at=now() WHERE id=${users[0].id}::uuid`;
    await tx`UPDATE public.password_reset_tokens SET used_at=now() WHERE user_id=${users[0].id}::uuid AND used_at IS NULL`;
    return true;
  });
}
