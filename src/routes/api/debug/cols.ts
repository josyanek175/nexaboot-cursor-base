import { createFileRoute } from "@tanstack/react-router";
import { sql } from "@/lib/pg.server";
import { requirePlatformDiagnostics } from "@/lib/platform-diagnostics.server";

export const Route = createFileRoute("/api/debug/cols")({
  server: {
    handlers: {
      GET: async () => {
        const denied=await requirePlatformDiagnostics();if(denied)return denied;
        const s = sql();
        const tables = await s`
          SELECT table_schema, table_name
          FROM information_schema.tables
          WHERE table_name = 'users'
        `;
        const cols = await s`
          SELECT table_schema, column_name, data_type
          FROM information_schema.columns
          WHERE table_name = 'users'
          ORDER BY table_schema, ordinal_position
        `;
        const sp = await s`SHOW search_path`;
        return Response.json({ tables, cols, search_path: sp });
      },
    },
  },
});
