import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureSchema } from "@/lib/pg.server";

export const Route = createFileRoute("/api/debug/db")({
  server: {
    handlers: {
      GET: async () => {
        const hasDatabaseUrl = !!process.env.DATABASE_URL;
        if (!hasDatabaseUrl) {
          return Response.json({ hasDatabaseUrl: false }, { status: 500 });
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
            connection: conn[0],
            tables,
            userCols,
            usersAll,
            counts: counts[0],
            search_path: sp[0],
          });
        } catch (e: any) {
          return Response.json(
            { hasDatabaseUrl: true, error: "db_error", message: e?.message ?? String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});
