// Login NexaBoot — autenticação própria no PostgreSQL (tabela public.users).
// NÃO usa Supabase Auth, auth.users, RLS, profiles, users_tenants nem user_roles.
// Fluxo: valida DB -> busca usuário -> checa ativo -> bcrypt.compare -> cria cookie httpOnly.
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
  password: z.string().min(1).max(200),
  // Opcional: o front atual NÃO envia tenant. Mantido apenas para diagnóstico.
  tenantId: z.string().max(64).optional().nullable(),
});

/** Mascarar a DATABASE_URL para logs (esconde a senha). */
function maskDbUrl(raw: string | undefined): string {
  if (!raw) return "(DATABASE_URL não configurada)";
  try {
    const u = new URL(raw);
    const cred = u.username ? `${u.username}:***@` : "";
    return `${u.protocol}//${cred}${u.host}${u.pathname}`;
  } catch {
    return "(DATABASE_URL com formato inválido)";
  }
}

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const startedAt = Date.now();
        const dbUrlMasked = maskDbUrl(process.env.DATABASE_URL);

        // 0) Conexão com o banco -----------------------------------------
        if (!process.env.DATABASE_URL) {
          console.error("[LOGIN_DB_MISSING]", { dbUrlMasked });
          return Response.json(
            { error: "db_connection_error", reason: "DATABASE_URL ausente" },
            { status: 503 },
          );
        }
        try {
          await ensureSchema();
        } catch (e) {
          console.error("[LOGIN_DB_FAIL]", {
            dbUrlMasked,
            message: (e as Error).message,
          });
          return Response.json(
            { error: "db_connection_error", reason: (e as Error).message },
            { status: 503 },
          );
        }

        // 1) Entrada -----------------------------------------------------
        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          console.warn("[LOGIN_INVALID_INPUT]", { dbUrlMasked });
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }
        const email = parsed.data.email.trim().toLowerCase();
        const password = parsed.data.password;
        const tenantHint = parsed.data.tenantId?.trim() || null;

        const s = sql();

        // Introspecção do banco realmente conectado (diagnóstico).
        let dbMeta: {
          database?: string;
          usr?: string;
          schema?: string;
          host?: string | null;
        } | null = null;
        try {
          const [m] = await s`
            SELECT current_database() AS database,
                   current_user      AS usr,
                   current_schema()  AS schema,
                   inet_server_addr()::text AS host
          `;
          dbMeta = m as typeof dbMeta;
        } catch (e) {
          console.warn("[LOGIN_DB_META_SKIP]", { message: (e as Error).message });
        }

        console.log("[LOGIN_ATTEMPT]", {
          email,
          tenantHint,
          dbUrlMasked,
          db: dbMeta,
          table: "public.users",
        });

        // 2) Buscar usuário ---------------------------------------------
        let rows: Array<{
          id: string;
          email: string;
          name: string;
          role: string;
          tenant_id: string;
          company_id: string | null;
          password_hash: unknown;
          active: boolean | null;
        }>;
        try {
          rows = (await s`
            SELECT id, email, name, role, tenant_id, company_id, password_hash, active
            FROM public.users
            WHERE lower(email) = ${email}
            LIMIT 1
          `) as typeof rows;
        } catch (e) {
          console.error("[LOGIN_QUERY_FAIL]", {
            email,
            message: (e as Error).message,
          });
          return Response.json(
            { error: "db_connection_error", reason: "falha ao consultar public.users" },
            { status: 503 },
          );
        }

        const u = rows[0];
        console.log("[LOGIN_USER_LOOKUP]", {
          email,
          table: "public.users",
          found: !!u,
          active: u?.active,
          role: u?.role,
          tenant_id: u?.tenant_id,
        });

        if (!u) {
          return Response.json({ error: "user_not_found" }, { status: 401 });
        }

        // 3) Usuário ativo ----------------------------------------------
        if (u.active === false) {
          console.warn("[LOGIN_USER_INACTIVE]", { userId: u.id, email: u.email });
          return Response.json({ error: "user_inactive" }, { status: 403 });
        }

        // 4) Hash presente ----------------------------------------------
        if (!u.password_hash || typeof u.password_hash !== "string") {
          console.error("[LOGIN_NO_HASH]", { userId: u.id, email: u.email });
          return Response.json(
            { error: "invalid_password", reason: "usuário sem password_hash" },
            { status: 401 },
          );
        }

        // 5) bcrypt.compare (senha pura x hash) --------------------------
        let bcryptMatch = false;
        try {
          bcryptMatch = await bcrypt.compare(password, u.password_hash);
        } catch (e) {
          console.error("[LOGIN_BCRYPT_FAIL]", {
            userId: u.id,
            message: (e as Error).message,
          });
          return Response.json(
            { error: "invalid_password", reason: "bcrypt.compare falhou" },
            { status: 401 },
          );
        }
        console.log("[LOGIN_PASSWORD_CHECK]", {
          userId: u.id,
          bcryptMatch,
          hashPrefix: u.password_hash.slice(0, 4), // ex.: "$2a$" / "$2b$" — confirma que é bcrypt
        });
        if (!bcryptMatch) {
          return Response.json({ error: "invalid_password" }, { status: 401 });
        }

        // 5.1) EMPRESA OBRIGATÓRIA (isolamento multitenant) --------------
        // Decisão oficial: company_id é a fonte única de isolamento. Nenhum
        // usuário opera sem empresa válida. Nesta fase TODOS os perfis exigem
        // empresa válida (inclusive ADMIN_GERAL/SUPER_ADMIN), pois ainda não há
        // tratamento explícito de acesso multiempresa.
        let companyValid = false;
        let companyName: string | null = null;
        if (u.company_id) {
          try {
            const c = await s`
              SELECT id, name FROM public.companies WHERE id = ${u.company_id}::uuid LIMIT 1
            `;
            if (c[0]) {
              companyValid = true;
              companyName = (c[0] as { name: string }).name;
            }
          } catch (e) {
            console.error("[LOGIN_COMPANY_CHECK_FAIL]", { userId: u.id, message: (e as Error).message });
          }
        }
        console.log("[LOGIN_COMPANY_CHECK]", {
          userId: u.id,
          company_id: u.company_id,
          companyValid,
        });
        if (!companyValid) {
          console.warn("[LOGIN_BLOCKED_NO_COMPANY]", { userId: u.id, email: u.email, role: u.role });
          return Response.json(
            {
              error: "no_company",
              message: "Usuário sem empresa vinculada. Contate o administrador.",
            },
            { status: 403 },
          );
        }

        // 6) Tenant — apenas diagnóstico, NÃO bloqueia o login -----------
        let tenantExists = false;
        try {
          const t = await s`SELECT id FROM public.tenants WHERE id = ${u.tenant_id} LIMIT 1`;
          tenantExists = t.length > 0;
        } catch (e) {
          console.warn("[LOGIN_TENANT_CHECK_SKIP]", { message: (e as Error).message });
        }
        console.log("[LOGIN_TENANT_CHECK]", {
          tenant_id: u.tenant_id,
          tenantExists,
        });

        // 7) last_login_at (não-fatal) -----------------------------------
        try {
          await s`UPDATE public.users SET last_login_at = now() WHERE id = ${u.id}`;
        } catch (e) {
          console.warn("[LOGIN_LAST_LOGIN_SKIP]", {
            userId: u.id,
            message: (e as Error).message,
          });
        }

        // 8) Sessão / cookie httpOnly (depende de SESSION_SECRET) --------
        // Anexamos o Set-Cookie EXPLICITAMENTE na Response (não dependemos do
        // merge de contexto do framework), garantindo que o header sempre vá.
        console.log("[LOGIN_SESSION_ENV]", {
          hasSessionSecret: hasSessionSecret(),
          nodeEnv: process.env.NODE_ENV,
        });
        let setCookieHeader: string;
        try {
          setCookieHeader = buildSessionSetCookie(u.id);
        } catch (e) {
          console.error("[LOGIN_SESSION_FAIL]", {
            userId: u.id,
            message: (e as Error).message,
          });
          return Response.json(
            { error: "session_not_created", reason: (e as Error).message },
            { status: 500 },
          );
        }

        const cookieAttrs = describeSessionCookie();
        console.log("[LOGIN_SET_COOKIE]", {
          userId: u.id,
          setCookieReturned: true,
          cookieAttrs, // name, httpOnly, sameSite, secure, path, maxAge, nodeEnv
        });

        console.log("[LOGIN_SUCCESS]", {
          userId: u.id,
          email: u.email,
          tenant_id: u.tenant_id,
          tenantExists,
          sessionCreated: true,
          ms: Date.now() - startedAt,
        });

        return Response.json(
          {
            user: {
              id: u.id,
              email: u.email,
              name: u.name,
              role: u.role,
              tenant_id: u.tenant_id,
              company_id: u.company_id,
              company_name: companyName,
              company_valid: true,
            },
            diag: {
              db: dbMeta?.database ?? null,
              table: "public.users",
              tenantExists,
              cookie: cookieAttrs,
            },
          },
          { headers: { "Set-Cookie": setCookieHeader } },
        );
      },
    },
  },
});
