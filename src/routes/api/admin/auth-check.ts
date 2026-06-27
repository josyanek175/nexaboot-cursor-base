// Endpoint TEMPORÁRIO de diagnóstico de autenticação.
// Confirma se o banco conectado contém o usuário e se as variáveis estão setadas.
// NÃO retorna password_hash completo.
import { createFileRoute } from "@tanstack/react-router";
import bcrypt from "bcryptjs";
import { sql, ensureSchema } from "@/lib/pg.server";
import { hasSessionSecret } from "@/lib/session.server";

const BCRYPT_PREFIX_RE = /^\$2[aby]\$/;

export const Route = createFileRoute("/api/admin/auth-check")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const emailParam = (url.searchParams.get("email") ?? "").trim().toLowerCase();
        const hasDatabaseUrl = !!process.env.DATABASE_URL;
        const hasSessionSecret = !!process.env.SESSION_SECRET;

        if (!emailParam) {
          return Response.json({
            hasDatabaseUrl,
            hasSessionSecret,
            error: "missing_email_query_param",
          });
        }

        try {
          await ensureSchema();
          const rows = await sql()`
            SELECT id, email, name, role, tenant_id, active, password_hash
            FROM public.users
            WHERE lower(email) = ${emailParam}
            LIMIT 1
          `;
          const u = rows[0];
          const hash = u?.password_hash ? String(u.password_hash) : null;
          return Response.json({
            hasDatabaseUrl,
            hasSessionSecret,
            email: emailParam,
            userFound: !!u,
            userId: u?.id ?? null,
            tenant_id: u?.tenant_id ?? null,
            role: u?.role ?? null,
            active: u?.active ?? null,
            hasPasswordHash: !!hash,
            passwordHashPrefix: hash ? hash.slice(0, 4) : null,
            bcryptHashValid: hash ? BCRYPT_PREFIX_RE.test(hash) : false,
          });
        } catch (e: any) {
          return Response.json(
            {
              hasDatabaseUrl,
              hasSessionSecret,
              email: emailParam,
              error: "db_error",
              message: e?.message ?? String(e),
            },
            { status: 500 },
          );
        }
      },

      // POST { email, password } -> roda bcrypt.compare SEM expor o hash.
      // Use para confirmar passo 2 do diagnóstico de forma segura.
      POST: async ({ request }) => {
        const hasDatabaseUrl = !!process.env.DATABASE_URL;
        const sessionSecretPresent = hasSessionSecret();
        const json = (await request.json().catch(() => null)) as
          | { email?: string; password?: string }
          | null;
        const email = (json?.email ?? "").trim().toLowerCase();
        const password = json?.password ?? "";
        if (!email || !password) {
          return Response.json(
            { error: "missing_email_or_password", hasDatabaseUrl, hasSessionSecret: sessionSecretPresent },
            { status: 400 },
          );
        }
        try {
          await ensureSchema();
          const rows = await sql()`
            SELECT id, email, role, tenant_id, active, password_hash
            FROM public.users
            WHERE lower(email) = ${email}
            LIMIT 1
          `;
          const u = rows[0];
          const hash = u?.password_hash ? String(u.password_hash) : null;
          const bcryptHashValid = hash ? BCRYPT_PREFIX_RE.test(hash) : false;
          let bcryptCompare: boolean | null = null;
          if (hash && bcryptHashValid) {
            bcryptCompare = await bcrypt.compare(password, hash);
          }
          console.log("[AUTH_CHECK_COMPARE]", {
            email,
            userFound: !!u,
            active: u?.active ?? null,
            bcryptHashValid,
            bcryptCompare,
          });
          return Response.json({
            hasDatabaseUrl,
            hasSessionSecret: sessionSecretPresent,
            email,
            userFound: !!u,
            active: u?.active ?? null,
            tenant_id: u?.tenant_id ?? null,
            role: u?.role ?? null,
            hasPasswordHash: !!hash,
            passwordHashPrefix: hash ? hash.slice(0, 4) : null,
            bcryptHashValid,
            bcryptCompare,
          });
        } catch (e: any) {
          return Response.json(
            {
              hasDatabaseUrl,
              hasSessionSecret: sessionSecretPresent,
              email,
              error: "db_error",
              message: e?.message ?? String(e),
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
