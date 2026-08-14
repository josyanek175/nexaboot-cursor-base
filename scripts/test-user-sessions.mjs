/**
 * Testes determinísticos da Fase 1 de sessões (hash/token/códigos/migration).
 * Uso: npx tsx scripts/test-user-sessions.mjs
 *
 * Não loga token. Integração DB (opcional) roda em transação com ROLLBACK.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import postgres from "postgres";
import {
  SESSION_REPLACED_ERROR,
  SESSION_REPLACED_MESSAGE,
} from "../src/lib/session-errors.ts";

let failed = 0;
function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

function hashSessionToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
function generateSessionToken() {
  return randomBytes(32).toString("base64url");
}

assert("SESSION_REPLACED_ERROR code", SESSION_REPLACED_ERROR === "session_replaced");
assert(
  "SESSION_REPLACED_MESSAGE",
  SESSION_REPLACED_MESSAGE ===
    "Sua sessão foi encerrada porque sua conta foi acessada em outro dispositivo.",
);

const t1 = generateSessionToken();
const t2 = generateSessionToken();
assert("token random length", t1.length >= 40);
assert("tokens differ", t1 !== t2);

const h1 = hashSessionToken(t1);
assert("hash sha256 hex 64", /^[a-f0-9]{64}$/.test(h1));
assert("hash deterministic", h1 === hashSessionToken(t1));
assert("hash unique per token", h1 !== hashSessionToken(t2));

const migration = readFileSync("scripts/migrations/20260812_user_sessions.sql", "utf8");
assert("migration has user_sessions", migration.includes("CREATE TABLE IF NOT EXISTS public.user_sessions"));
assert("migration unique active per user", migration.includes("user_sessions_one_active_per_user"));
assert("migration token_hash UNIQUE", /token_hash TEXT NOT NULL UNIQUE/.test(migration));
assert("no plaintext token column", !/session_token\s+TEXT/i.test(migration));

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  if (!existsSync(".env")) return null;
  const raw = readFileSync(".env", "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  if (!line) return null;
  return line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");
}

async function runDbTests(url) {
  const sql = postgres(url, { max: 2, prepare: false, idle_timeout: 5 });
  try {
    await sql.unsafe(readFileSync("scripts/migrations/20260812_user_sessions.sql", "utf8"));

    const users = await sql`SELECT id FROM public.users WHERE COALESCE(active, true) = true LIMIT 1`;
    if (!users[0]) {
      console.log("SKIP db integration (no active user)");
      return;
    }
    const userId = users[0].id;
    const hashA = hashSessionToken(generateSessionToken());
    const hashB = hashSessionToken(generateSessionToken());
    const exp = new Date(Date.now() + 60_000);

    try {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE public.user_sessions
          SET revoked_at = now(), revoked_reason = 'replaced_by_new_login'
          WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
        `;
        await tx`
          INSERT INTO public.user_sessions (user_id, token_hash, expires_at)
          VALUES (${userId}::uuid, ${hashA}, ${exp})
        `;
        const active1 = await tx`
          SELECT count(*)::int AS c FROM public.user_sessions
          WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
        `;
        assert("A) one active after first insert", active1[0].c === 1);

        await tx`
          UPDATE public.user_sessions
          SET revoked_at = now(), revoked_reason = 'replaced_by_new_login'
          WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
        `;
        await tx`
          INSERT INTO public.user_sessions (user_id, token_hash, expires_at)
          VALUES (${userId}::uuid, ${hashB}, ${exp})
        `;
        const active2 = await tx`
          SELECT count(*)::int AS c FROM public.user_sessions
          WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
        `;
        assert("D) still one active after second login", active2[0].c === 1);

        const prev = await tx`
          SELECT revoked_reason FROM public.user_sessions
          WHERE token_hash = ${hashA} LIMIT 1
        `;
        assert(
          "D) previous revoked replaced_by_new_login",
          prev[0]?.revoked_reason === "replaced_by_new_login",
        );

        await tx`
          UPDATE public.user_sessions
          SET revoked_at = now(), revoked_reason = 'logout'
          WHERE token_hash = ${hashB} AND revoked_at IS NULL
        `;
        const afterLogout = await tx`
          SELECT revoked_at IS NOT NULL AS revoked FROM public.user_sessions
          WHERE token_hash = ${hashB} LIMIT 1
        `;
        assert("F) logout revokes row", afterLogout[0]?.revoked === true);

        throw new Error("rollback_test_ok");
      });
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "rollback_test_ok") throw e;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const dbUrl = loadDatabaseUrl();
if (dbUrl) {
  try {
    await runDbTests(dbUrl);
  } catch (e) {
    console.error("DB integration failed:", e instanceof Error ? e.message : e);
    failed += 1;
  }
} else {
  console.log("SKIP db integration (no DATABASE_URL)");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll user-session phase-1 tests passed");
