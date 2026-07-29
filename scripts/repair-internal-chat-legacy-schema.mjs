/**
 * MANUAL REPAIR — schema legado de chat interno.
 *
 * NÃO é chamado no boot da aplicação.
 *
 * Quando `public.internal_messages` existe sem a coluna `chat_id`, o bootstrap
 * aborta com INTERNAL_CHAT_LEGACY_SCHEMA_DETECTED e NÃO executa DROP.
 *
 * Este script é o único caminho explícito para o repair destrutivo antigo
 * (DROP das 4 tabelas + recreate via ensureSchema no próximo boot).
 *
 * Uso (após backup):
 *   CONFIRM_INTERNAL_CHAT_LEGACY_DROP=yes node scripts/repair-internal-chat-legacy-schema.mjs
 *
 * Sem a variável de confirmação, apenas detecta e imprime o SQL — não altera nada.
 */
import postgres from "postgres";

const CONFIRM = process.env.CONFIRM_INTERNAL_CHAT_LEGACY_DROP === "yes";
const url = process.env.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL não configurada");
  process.exit(1);
}

const sql = postgres(url, {
  max: 1,
  prepare: false,
  ssl:
    url.includes("sslmode=require") || url.includes("supabase") || url.includes("neon")
      ? "require"
      : undefined,
});

const DROP_SQL = `
DROP TABLE IF EXISTS internal_notifications CASCADE;
DROP TABLE IF EXISTS internal_messages CASCADE;
DROP TABLE IF EXISTS internal_chat_members CASCADE;
DROP TABLE IF EXISTS internal_chats CASCADE;
`;

try {
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'internal_messages'
  `;
  const hasChatId = cols.some((c) => c.column_name === "chat_id");

  if (cols.length === 0) {
    console.log("[REPAIR_INTERNAL_CHAT] tabela internal_messages ausente — nada a fazer");
    process.exit(0);
  }

  if (hasChatId) {
    console.log("[REPAIR_INTERNAL_CHAT] schema moderno (chat_id presente) — nada a fazer");
    process.exit(0);
  }

  console.error("[INTERNAL_CHAT_LEGACY_SCHEMA_DETECTED]", {
    table: "internal_messages",
    missingColumn: "chat_id",
    action: CONFIRM ? "DROP_CONFIRMED" : "DRY_RUN",
  });

  console.log("--- SQL proposto ---");
  console.log(DROP_SQL.trim());
  console.log("---------------------");

  if (!CONFIRM) {
    console.log(
      "Dry-run: defina CONFIRM_INTERNAL_CHAT_LEGACY_DROP=yes para executar o DROP (após backup).",
    );
    process.exit(2);
  }

  await sql.unsafe(DROP_SQL);
  console.log("[REPAIR_INTERNAL_CHAT_DROP_OK] reinicie a app para o bootstrap recriar as tabelas");
  process.exit(0);
} catch (e) {
  console.error("[REPAIR_INTERNAL_CHAT_FAIL]", e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
