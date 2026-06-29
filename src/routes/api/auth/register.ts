import { createFileRoute } from "@tanstack/react-router";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { sql, ensureSchema } from "@/lib/pg.server";
import {
  buildSessionSetCookie,
  describeSessionCookie,
  hasSessionSecret,
} from "@/lib/session.server";

const Body = z.object({
  email: z.string().email().max(255),
  password: z.string().min(6).max(200),
  name: z.string().min(1).max(120),
  tenantId: z.string().max(64).optional().nullable(),
  role: z.enum(["ADMIN", "USER"]).optional(),
});

export const Route = createFileRoute("/api/auth/register")({
  server: {
    handlers: {
      // GET: informa o modo atual. O cadastro público só existe para BOOTSTRAP
      // (primeiro usuário). Demais usuários são criados pela gestão (/api/users).
      GET: async () => {
        try {
          await ensureSchema();
          const s = sql();
          const count = await s`SELECT COUNT(*)::int AS c FROM public.users`;
          const total = Number(count[0]?.c ?? 0);
          if (total === 0) return Response.json({ mode: "bootstrap" });
          return Response.json({ mode: "forbidden" });
        } catch (e) {
          console.error("[register:GET] erro:", e);
          return Response.json(
            { error: "Falha ao verificar status", detail: (e as Error).message },
            { status: 500 },
          );
        }
      },

      POST: async ({ request }) => {
        try {
          await ensureSchema();
        } catch (e) {
          console.error("[register] ensureSchema falhou:", e);
          return Response.json(
            { error: "Falha ao preparar o banco de dados", detail: (e as Error).message },
            { status: 500 },
          );
        }

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json(
            { error: "Dados inválidos", detail: parsed.error.flatten() },
            { status: 400 },
          );
        }

        try {
          const s = sql();
          const count = await s`SELECT COUNT(*)::int AS c FROM public.users`;
          const isBootstrap = Number(count[0]?.c ?? 0) === 0;

          // Segurança multitenant: NÃO existe criação de usuário operacional sem
          // empresa por este endpoint. A gestão de usuários (com empresa vinculada)
          // é feita por /api/users, que grava company_id = empresa do administrador.
          // O register público fica restrito ao BOOTSTRAP (primeiro usuário), que
          // cria a própria empresa para não nascer sem vínculo.
          if (!isBootstrap) {
            return Response.json(
              {
                error:
                  "Cadastro indisponível. Usuários devem ser criados pela gestão de usuários, vinculados a uma empresa.",
              },
              { status: 403 },
            );
          }

          const email = parsed.data.email.toLowerCase().trim();
          const name = parsed.data.name.trim();
          const password = parsed.data.password;
          const role = "ADMIN";
          const tenantId = parsed.data.tenantId?.trim() || "default";

          console.log("[REGISTER_START]", { email, tenantId, role, isBootstrap });

          if (!name || !email || !password) {
            return Response.json({ error: "Campos obrigatórios ausentes" }, { status: 400 });
          }

          try {
            const [dbMeta] = await s`
              SELECT current_database() AS db, current_user AS usr, current_schema() AS schema
            `;
            console.log("[REGISTER_DB]", dbMeta);
          } catch (e) {
            console.warn("[REGISTER_DB] introspecção falhou:", (e as Error).message);
          }

          const existing = await s`
            SELECT id FROM public.users WHERE lower(email) = ${email}
          `;
          if (existing.length) {
            return Response.json(
              { error: "Usuário já cadastrado" },
              { status: 409 },
            );
          }

          // Bootstrap cria a própria empresa, para o primeiro admin já nascer
          // vinculado (nunca operacional sem empresa).
          const companyRows = await s<{ id: string }[]>`
            INSERT INTO public.companies (name)
            VALUES ('Empresa Principal')
            RETURNING id
          `;
          const companyId = companyRows[0].id;

          const hash = await bcrypt.hash(password, 10);
          const rows = await s`
            INSERT INTO public.users (email, password_hash, name, role, tenant_id, company_id)
            VALUES (${email}, ${hash}, ${name}, ${role}, ${tenantId}, ${companyId}::uuid)
            RETURNING id, tenant_id, company_id, name, email, role, created_at
          `;
          console.log("[REGISTER_BOOTSTRAP_COMPANY]", { companyId, userEmail: email });
          const u = rows[0];
          if (!u) {
            console.error("[REGISTER_INSERT_FAIL] RETURNING vazio");
            return Response.json(
              { success: false, error: "INSERT não retornou usuário" },
              { status: 500 },
            );
          }
          console.log("[REGISTER_INSERT_OK]", { id: u.id, email: u.email, tenant_id: u.tenant_id });

          // No bootstrap (primeiro usuário) já criamos a sessão, igual ao login:
          // Set-Cookie EXPLÍCITO no header da Response (não depende do framework).
          let setCookieHeader: string | null = null;
          if (isBootstrap) {
            console.log("[REGISTER_SESSION_ENV]", {
              hasSessionSecret: hasSessionSecret(),
              nodeEnv: process.env.NODE_ENV,
            });
            setCookieHeader = buildSessionSetCookie(u.id);
            console.log("[REGISTER_SET_COOKIE]", {
              userId: u.id,
              setCookieReturned: true,
              cookieAttrs: describeSessionCookie(), // name, httpOnly, sameSite, secure, path, maxAge, nodeEnv
            });
          }

          const [dbInfo] = await s`
            SELECT current_database() AS database,
                   current_user AS "user",
                   current_schema() AS schema
          `;
          const [{ c: usersCount }] = await s`SELECT COUNT(*)::int AS c FROM public.users`;

          console.log("[REGISTER_SUCCESS]", {
            userId: u.id,
            email: u.email,
            tenant_id: u.tenant_id,
            bootstrap: isBootstrap,
            sessionCreated: isBootstrap,
          });

          return Response.json(
            {
              success: true,
              user: u,
              bootstrap: isBootstrap,
              db: {
                database: dbInfo?.database ?? null,
                user: dbInfo?.user ?? null,
                schema: dbInfo?.schema ?? null,
                usersCount,
              },
            },
            setCookieHeader ? { headers: { "Set-Cookie": setCookieHeader } } : undefined,
          );
        } catch (e) {
          const err = e as { message?: string; code?: string; detail?: string };
          console.error("[REGISTER_INSERT_FAIL]", {
            message: err.message,
            code: err.code,
            detail: err.detail,
            full: e,
          });
          if (err.code === "23505") {
            return Response.json(
              { success: false, error: "Usuário já cadastrado neste tenant", detail: err.detail ?? err.message },
              { status: 409 },
            );
          }
          return Response.json(
            {
              success: false,
              error: "Falha ao registrar usuário. Tente novamente.",
              detail: err.detail ?? err.message ?? "erro desconhecido",
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
