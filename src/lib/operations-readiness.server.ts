import { getSql } from "@/lib/pg.server";

export const OPERATIONS_COLUMNS: Record<string, readonly string[]> = {
  company_operations_settings: [
    "company_id",
    "waiting_attendant_minutes",
    "waiting_customer_hours",
    "restrict_channels",
    "updated_at",
  ],
  company_teams: ["id", "company_id", "name"],
  company_team_members: ["company_id", "team_id", "user_id"],
  company_channel_grants: ["id", "company_id", "channel_id", "user_id", "team_id"],
};
export function operationsJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
/** Somente leitura. Não cria tabelas, não altera permissões e não ativa restrições. */
export async function checkOperationsSchema(): Promise<Response | null> {
  const rows = await getSql()<{ table_name: string; column_name: string; can_read: boolean }[]>`
    SELECT c.relname AS table_name, a.attname AS column_name,
           has_table_privilege(current_user, c.oid, 'SELECT') AS can_read
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND c.relname=ANY(${Object.keys(OPERATIONS_COLUMNS)}::text[])
      AND a.attnum>0 AND NOT a.attisdropped
  `;
  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  for (const [table, columns] of Object.entries(OPERATIONS_COLUMNS)) {
    const found = rows.filter((r) => r.table_name === table);
    if (!found.length) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns)
      if (!found.some((r) => r.column_name === column)) missingColumns.push(`${table}.${column}`);
  }
  if (missingTables.length || missingColumns.length)
    return operationsJson(
      {
        error: "operations_schema_missing",
        message:
          "A configuração de equipes e números está incompleta neste banco. As alterações ficam bloqueadas até a preparação ser concluída.",
        details: { missingTables, missingColumns },
      },
      503,
    );
  if (rows.some((r) => !r.can_read))
    return operationsJson(
      {
        error: "operations_database_permission",
        message:
          "O serviço não tem permissão para consultar a configuração de equipes e números neste banco. Solicite a revisão ao suporte.",
      },
      503,
    );
  return null;
}
/** Retorna apenas classificação segura; nunca expõe SQL, conexão, tokens ou mensagens brutas. */
export function operationsErrorResponse(error: unknown, route: string): Response {
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
  console.error("[COMPANY_OPERATIONS_FAILED]", {
    route,
    code: /^[A-Z0-9_]{2,40}$/.test(code) ? code : "unknown",
  });
  if (code === "23505")
    return operationsJson(
      {
        error: "duplicate_name",
        message: "Já existe um cadastro com esse nome. Confira os dados antes de salvar.",
      },
      409,
    );
  if (code === "23503")
    return operationsJson(
      {
        error: "related_record_missing",
        message: "Um dos cadastros relacionados não está mais disponível. Recarregue a tela.",
      },
      409,
    );
  if (code === "42501")
    return operationsJson(
      {
        error: "operations_database_permission",
        message:
          "O serviço não tem permissão para realizar esta operação no banco. Solicite a revisão ao suporte.",
      },
      503,
    );
  if (code === "42P01" || code === "42703")
    return operationsJson(
      {
        error: "operations_schema_incompatible",
        message:
          "A estrutura de equipes e números deste banco está incompleta. Recarregue para conferir o diagnóstico.",
      },
      503,
    );
  const unavailable =
    code.startsWith("08") ||
    [
      "53300",
      "57P01",
      "57P02",
      "57P03",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "CONNECT_TIMEOUT",
      "CONNECTION_CLOSED",
      "CONNECTION_ENDED",
      "CONNECTION_DESTROYED",
    ].includes(code);
  return operationsJson(
    {
      error: unavailable ? "operations_database_unavailable" : "operations_failed",
      message: unavailable
        ? "O banco está temporariamente indisponível. Tente novamente em alguns instantes."
        : "Não foi possível concluir a operação. Solicite a verificação dos logs pelo suporte.",
    },
    unavailable ? 503 : 500,
  );
}
