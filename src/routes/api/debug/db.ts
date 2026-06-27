import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";

/** Decompõe a DATABASE_URL para comparação, sem expor a senha. */
function describeDbUrl(raw: string | undefined) {
  if (!raw) return { present: false as const };
  try {
    const u = new URL(raw);
    return {
      present: true as const,
      protocol: u.protocol.replace(":", ""),
      user: u.username || null,
      host: u.hostname,
      port: u.port || null,
      database: u.pathname.replace(/^\//, "") || null,
      masked: `${u.protocol}//${u.username ? `${u.username}:***@` : ""}${u.host}${u.pathname}`,
    };
  } catch {
    return { present: true as const, error: "invalid_url_format" as const };
  }
}

export const Route = createFileRoute("/api/debug/db")({
  server: {
    handlers: {
      GET: async () => {
        const hasDatabaseUrl = !!process.env.DATABASE_URL;
        const databaseUrl = describeDbUrl(process.env.DATABASE_URL);
        if (!hasDatabaseUrl) {
          return Response.json({ hasDatabaseUrl: false, databaseUrl }, { status: 500 });
        }
        try {
          await ensureSchema();
          const s = sql();
          const conn = await s`
            SELECT inet_server_addr()::text AS host, inet_server_port() AS port,
                   current_database() AS database, current_user AS "user",
                   current_schema AS schema
          `;
          const tables = await s`
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_name IN ('users','contacts','conversations','messages','tenants')
            ORDER BY table_schema, table_name
          `;
          const userCols = await s`
            SELECT table_schema, column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'users'
            ORDER BY table_schema, ordinal_position
          `;
          const usersAll = await s`
            SELECT id, email, role, tenant_id, active
            FROM public.users
            ORDER BY created_at DESC NULLS LAST
            LIMIT 20
          `;
          const counts = await s`
            SELECT
              (SELECT count(*)::int FROM public.users) AS users,
              (SELECT count(*)::int FROM public.contacts) AS contacts,
              (SELECT count(*)::int FROM public.conversations) AS conversations,
              (SELECT count(*)::int FROM public.messages) AS messages
          `;
          const sp = await s`SHOW search_path`;
          return Response.json({
            hasDatabaseUrl: true,
            databaseUrl,
            connection: conn[0],
            tables,
            userCols,
            usersAll,
            counts: counts[0],
            search_path: sp[0],
          });
        } catch (e: any) {
          return Response.json(
            { hasDatabaseUrl: true, databaseUrl, error: "db_error", message: e?.message ?? String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});
