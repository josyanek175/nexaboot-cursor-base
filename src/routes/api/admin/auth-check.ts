// Endpoint TEMPORÁRIO de diagnóstico de autenticação.
// Confirma se o banco conectado contém o usuário e se as variáveis estão setadas.
// NÃO retorna password_hash completo.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";

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
          return Response.json({
            hasDatabaseUrl,
            hasSessionSecret,
            email: emailParam,
            userFound: !!u,
            userId: u?.id ?? null,
            tenant_id: u?.tenant_id ?? null,
            role: u?.role ?? null,
            active: u?.active ?? null,
            hasPasswordHash: !!u?.password_hash,
            passwordHashPrefix:
              u?.password_hash ? String(u.password_hash).slice(0, 4) : null,
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
    },
  },
});
