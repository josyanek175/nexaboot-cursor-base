// Diagnóstico READ-ONLY do schema do banco principal (nexaboot-postgres).
// NÃO escreve nada, NÃO chama ensureSchema, NÃO cria/altera tabelas.
// Retorna: existência das tabelas, colunas reais, PKs, FKs, índices/constraints,
// se usa company_id/tenant_id, canais Evolution já cadastrados e colunas faltantes.
// Uso: GET /api/evolution/schema-check
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "@/lib/pg.server";

// Colunas que o código (webhook + messages.ts + envio) espera em cada tabela.
const EXPECTED: Record<string, string[]> = {
  companies: ["id"], // só checa existência; company_id é usado como FK lógica
  whatsapp_channels: [
    "id", "company_id", "channel_type", "evolution_instance_name",
    "name", "status", "last_connected_at",
  ],
  contacts: [
    "id", "company_id", "phone", "name", "external_jid",
    "contact_type", "created_at", "updated_at",
  ],
  conversations: [
    "id", "company_id", "contact_id", "whatsapp_channel_id", "status",
    "unread_count", "last_message", "last_message_at", "created_at", "updated_at",
  ],
  messages: [
    "id", "conversation_id", "external_id", "external_message_id", "direction",
    "message_type", "message_text", "from_me", "raw_payload",
    "media_type", "media_mimetype", "mime_type", "media_filename", "media_caption",
    "media_base64", "media_error", "media_url", "media_seconds", "status", "created_at",
  ],
};

const TABLES = Object.keys(EXPECTED);

export const Route = createFileRoute("/api/evolution/schema-check")({
  server: {
    handlers: {
      GET: async () => {
        if (!process.env.DATABASE_URL) {
          return Response.json({ error: "DATABASE_URL não configurada" }, { status: 500 });
        }
        try {
          const s = sql();

          const conn = await s`
            SELECT current_database() AS database, current_user AS "user",
                   inet_server_addr()::text AS host, inet_server_port() AS port
          `;

          // ── Colunas ────────────────────────────────────────────────
          const colRows = await s<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
            SELECT table_name, column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ANY(${TABLES})
            ORDER BY table_name, ordinal_position
          `;
          const colsByTable = new Map<string, { name: string; type: string; nullable: boolean; default: string | null }[]>();
          for (const r of colRows) {
            const arr = colsByTable.get(r.table_name) ?? [];
            arr.push({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === "YES", default: r.column_default });
            colsByTable.set(r.table_name, arr);
          }

          // ── Primary keys & UNIQUE ─────────────────────────────────
          const pkRows = await s<{ table_name: string; constraint_type: string; constraint_name: string; column_name: string }[]>`
            SELECT tc.table_name, tc.constraint_type, tc.constraint_name, kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            WHERE tc.table_schema = 'public'
              AND tc.table_name = ANY(${TABLES})
              AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
            ORDER BY tc.table_name, tc.constraint_type, kcu.ordinal_position
          `;
          const pkByTable = new Map<string, string[]>();
          const uniqueByTable = new Map<string, Record<string, string[]>>();
          for (const r of pkRows) {
            if (r.constraint_type === "PRIMARY KEY") {
              const arr = pkByTable.get(r.table_name) ?? [];
              arr.push(r.column_name);
              pkByTable.set(r.table_name, arr);
            } else {
              const obj = uniqueByTable.get(r.table_name) ?? {};
              obj[r.constraint_name] = [...(obj[r.constraint_name] ?? []), r.column_name];
              uniqueByTable.set(r.table_name, obj);
            }
          }

          // ── Foreign keys ──────────────────────────────────────────
          const fkRows = await s<{ table_name: string; constraint_name: string; column_name: string; foreign_table: string; foreign_column: string }[]>`
            SELECT tc.table_name, tc.constraint_name,
                   kcu.column_name,
                   ccu.table_name AS foreign_table,
                   ccu.column_name AS foreign_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name
             AND tc.table_schema = ccu.table_schema
            WHERE tc.table_schema = 'public'
              AND tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_name = ANY(${TABLES})
            ORDER BY tc.table_name
          `;
          const fkByTable = new Map<string, string[]>();
          for (const r of fkRows) {
            const arr = fkByTable.get(r.table_name) ?? [];
            arr.push(`${r.column_name} -> ${r.foreign_table}.${r.foreign_column}`);
            fkByTable.set(r.table_name, arr);
          }

          // ── Índices ───────────────────────────────────────────────
          const idxRows = await s<{ tablename: string; indexname: string; indexdef: string }[]>`
            SELECT tablename, indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = ANY(${TABLES})
            ORDER BY tablename, indexname
          `;
          const idxByTable = new Map<string, string[]>();
          for (const r of idxRows) {
            const arr = idxByTable.get(r.tablename) ?? [];
            arr.push(r.indexdef);
            idxByTable.set(r.tablename, arr);
          }

          // ── Monta o relatório por tabela ──────────────────────────
          const report = TABLES.map((table) => {
            const cols = colsByTable.get(table) ?? [];
            const exists = cols.length > 0;
            const present = new Set(cols.map((c) => c.name));
            const expected = EXPECTED[table];
            const missing = expected.filter((c) => !present.has(c));
            return {
              table,
              exists,
              usesCompanyId: present.has("company_id"),
              usesTenantId: present.has("tenant_id"),
              primaryKey: pkByTable.get(table) ?? [],
              foreignKeys: fkByTable.get(table) ?? [],
              uniqueConstraints: uniqueByTable.get(table) ?? {},
              indexes: idxByTable.get(table) ?? [],
              columns: cols.map((c) => `${c.name} ${c.type}${c.nullable ? "" : " NOT NULL"}${c.default ? ` DEFAULT ${c.default}` : ""}`),
              expectedByCode: expected,
              missingForWebhook: missing,
            };
          });

          // ── Contagens (sem expor conteúdo) ────────────────────────
          const counts: Record<string, number | string> = {};
          for (const t of ["companies", "whatsapp_channels", "contacts", "conversations", "messages"]) {
            try {
              const c = await s.unsafe(`SELECT count(*)::int AS n FROM public.${t}`);
              counts[t] = (c[0] as { n: number })?.n ?? 0;
            } catch {
              counts[t] = "table_missing";
            }
          }

          // ── Canais Evolution já cadastrados ───────────────────────
          let evolutionChannels: unknown = "n/a";
          let hasEvolutionInstanceNameColumn = false;
          try {
            const colCheck = await s`
              SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='whatsapp_channels'
                AND column_name='evolution_instance_name' LIMIT 1
            `;
            hasEvolutionInstanceNameColumn = colCheck.length > 0;
          } catch { /* ignore */ }
          try {
            evolutionChannels = await s.unsafe(`
              SELECT id, name, channel_type, evolution_instance_name, status
              FROM public.whatsapp_channels
              WHERE channel_type = 'EVOLUTION'
              LIMIT 50
            `);
          } catch (e) {
            evolutionChannels = { error: (e as Error).message };
          }

          return Response.json({
            ok: true,
            connection: conn[0],
            report,
            counts,
            hasEvolutionInstanceNameColumn,
            evolutionChannels,
            note:
              "Read-only. usesTenantId=true => schema legado Supabase; o código espera company_id. " +
              "Cole este JSON completo no chat para liberar a implementação dos endpoints 1–6.",
          });
        } catch (e) {
          return Response.json(
            { ok: false, error: "db_error", message: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});
