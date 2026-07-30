/**
 * Garante que fragments sql`` + ORDER BY dinâmico não são corrompidos
 * (regressão do Proxy Object.apply).
 * Sem DATABASE_URL: valida forma do helper postgres.js.
 * Com DATABASE_URL: executa queries reais (fragment + ORDER + >25 params + begin).
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const envPath = join(here, "../.env");
  if (!existsSync(envPath) || process.env.DATABASE_URL) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^DATABASE_URL=(.*)$/);
    if (!m) continue;
    let v = m[1].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env.DATABASE_URL = v;
    break;
  }
}

async function testNoProxyInPgServer() {
  const src = readFileSync(join(here, "../src/lib/pg.server.ts"), "utf8");
  assert.equal(/new Proxy\s*\(/.test(src), false, "pg.server must not Proxy sql client");
  assert.equal(/wrapPostgresClient/.test(src), false);
  assert.ok(src.includes("export function getSql"));
  assert.ok(
    /export function getSql[\s\S]*?return sql\(\)/.test(src),
    "getSql must return raw sql() client",
  );
  assert.ok(src.includes("export async function reserveSqlConnection"));
  console.log("[TEST] no Proxy wrapper in pg.server: OK");
}

async function testConversationsQueryUsesFragments() {
  const src = readFileSync(
    join(here, "../src/lib/conversations-query.server.ts"),
    "utf8",
  );
  assert.ok(src.includes("${orderClause}"));
  assert.ok(src.includes("ORDER BY"));
  assert.ok(src.includes("resolvedCampaignColorExpr"));
  // Conta parâmetros dinâmicos típicos (muitos $N) — regressão $26.
  const interpolations = (src.match(/\$\{/g) ?? []).length;
  assert.ok(interpolations >= 20, `expected many interpolations, got ${interpolations}`);
  console.log("[TEST] conversations query fragment shape intact: OK");
}

async function testAuthMeStillNoReserve() {
  const src = readFileSync(join(here, "../src/lib/auth-me-diag.server.ts"), "utf8");
  assert.equal(/reserveSqlConnection|\.reserve\s*\(/.test(src), false);
  assert.equal(/Promise\.race\s*\(/.test(src), false);
  assert.ok(src.includes("SET LOCAL statement_timeout"));
  console.log("[TEST] /me still without reserve: OK");
}

async function testFragmentCompositionWithoutProxy() {
  // Simula o contrato postgres.js: tagged template deve retornar Helper, não Promise.
  function fakeSql(strings, ...values) {
    return { strings, values, type: "fragment" };
  }
  const orderClause = fakeSql`ORDER BY c.last_message_at DESC`;
  const q = fakeSql`
    SELECT * FROM conversations c
    WHERE c.company_id = ${"uuid"}
    ${orderClause}
    LIMIT ${50}
  `;
  assert.equal(q.type, "fragment");
  assert.equal(q.values.includes(orderClause), true);
  assert.equal(q.values.some((v) => v && typeof v.then === "function"), false);
  console.log("[TEST] fragment composition is not a Promise: OK");
}

/**
 * Reproduz o padrão que quebrava com Proxy:
 * fragment ORDER BY + fragment SQL + lista + >25 parâmetros.
 */
async function testLiveConversationsShape() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("[TEST] live DB skipped (DATABASE_URL absent)");
    return;
  }

  const sql = postgres(url, {
    max: 2,
    prepare: false,
    ssl:
      url.includes("sslmode=require") ||
      url.includes("supabase") ||
      url.includes("neon")
        ? "require"
        : undefined,
  });

  try {
    const companyId = "00000000-0000-4000-8000-000000000001";
    const userId = "00000000-0000-4000-8000-000000000002";
    const p = Array.from({ length: 20 }, (_, i) => `p${i}`);

    const colorExpr = sql`CASE WHEN true THEN '#6B7280' ELSE NULL END`;
    assert.equal(typeof colorExpr.then, "undefined", "fragment must not be a Promise");

    const orderClause = sql`ORDER BY 1 DESC NULLS LAST`;
    assert.equal(typeof orderClause.then, "undefined");

    // Espelha conversations-query: fragment no SELECT, muitos params, ORDER dinâmico.
    const rows = await sql`
      SELECT
        ${colorExpr} AS resolved_color,
        ${p[0]}::text AS a0, ${p[1]}::text AS a1, ${p[2]}::text AS a2,
        ${p[3]}::text AS a3, ${p[4]}::text AS a4, ${p[5]}::text AS a5,
        ${p[6]}::text AS a6, ${p[7]}::text AS a7, ${p[8]}::text AS a8,
        ${p[9]}::text AS a9, ${p[10]}::text AS a10, ${p[11]}::text AS a11,
        ${p[12]}::text AS a12, ${p[13]}::text AS a13, ${p[14]}::text AS a14,
        ${p[15]}::text AS a15, ${p[16]}::text AS a16, ${p[17]}::text AS a17,
        ${p[18]}::text AS a18, ${p[19]}::text AS a19,
        ${companyId}::text AS company_id,
        ${userId}::text AS user_id,
        ${false}::boolean AS campaign_queue,
        ${null}::text AS campaign_status,
        ${null}::uuid AS campaign_id,
        ${null}::text AS campaign_color
      FROM (SELECT 1 AS n) t
      WHERE ${companyId}::text IS NOT NULL
        AND (${null}::text IS NULL OR ${null}::text = ${"x"})
        AND (${false}::boolean = false OR true)
      ${orderClause}
      LIMIT ${5}
    `;
    assert.ok(Array.isArray(rows));
    assert.equal(rows[0]?.resolved_color, "#6B7280");
    console.log("[TEST] live fragment+ORDER+>25 params: OK");

    // Lista / IN style
    const ids = sql([1, 2, 3]);
    const listRows = await sql`SELECT * FROM (VALUES (1),(2),(3)) v(n) WHERE n IN ${ids}`;
    assert.equal(listRows.length, 3);
    console.log("[TEST] live list interpolation: OK");

    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = 5000`);
      const r = await tx`SELECT 1::int AS n`;
      assert.equal(r[0].n, 1);
    });
    console.log("[TEST] live sql.begin + statement_timeout: OK");

    // Smoke nas tabelas das rotas críticas (somente SELECT).
    await sql`SELECT 1 FROM public.conversations LIMIT 0`.catch((e) => {
      if (e?.code === "42P01") return; // tabela ausente em DB vazio
      throw e;
    });
    await sql`SELECT 1 FROM public.campaigns LIMIT 0`.catch((e) => {
      if (e?.code === "42P01") return;
      throw e;
    });
    await sql`SELECT 1 FROM public.contacts LIMIT 0`.catch((e) => {
      if (e?.code === "42P01") return;
      throw e;
    });
    console.log("[TEST] live attendance/campaigns/contacts smoke: OK");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  loadDotEnv();
  await testNoProxyInPgServer();
  await testConversationsQueryUsesFragments();
  await testAuthMeStillNoReserve();
  await testFragmentCompositionWithoutProxy();
  await testLiveConversationsShape();
  console.log("[TEST] proxy removal checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
