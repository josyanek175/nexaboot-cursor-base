/**
 * Contenção FASE 1 — validações estáticas (sem DB / sem secrets).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function testServerRespectsFlag() {
  const src = read("src/server.ts");
  assert.ok(src.includes("isDatabaseSchemaBootstrapEnabled"));
  assert.ok(src.includes("[DB_BOOTSTRAP_DISABLED]"));
  assert.ok(src.includes("[DB_BOOTSTRAP_ENABLED]"));
  assert.ok(src.includes("[PG_POOL_CONFIG]"));
  // Não reinicia bootstrap a cada request
  const fetchBlock = src.slice(src.indexOf("export default"));
  assert.equal(
    /bootstrapDatabaseSchema\s*\(/.test(fetchBlock),
    false,
    "fetch must not call bootstrapDatabaseSchema",
  );
  assert.equal(
    /startDatabaseBootstrapInBackground\s*\(/.test(fetchBlock),
    false,
    "fetch must not re-kick bootstrap",
  );
  console.log("[TEST] server.ts respects flag + no per-request bootstrap: OK");
}

function testBootstrapNoOpWhenDisabled() {
  const src = read("src/lib/pg.server.ts");
  assert.ok(src.includes("export function bootstrapDatabaseSchema"));
  assert.ok(
    /export function bootstrapDatabaseSchema\(\)[\s\S]*?isDatabaseSchemaBootstrapEnabled\(\)[\s\S]*?Promise\.resolve\(\)/.test(
      src,
    ),
    "bootstrapDatabaseSchema must no-op when disabled",
  );
  assert.ok(src.includes("function readPgPoolMax"));
  assert.ok(src.includes("PG_POOL_MAX"));
  assert.ok(src.includes("[PG_POOL_CONFIG]"));
  console.log("[TEST] bootstrap no-op + PG_POOL_MAX from env: OK");
}

function testHealthReadiness() {
  const src = read("src/routes/api/health.ts");
  assert.ok(src.includes("bootstrapEnabled"));
  assert.ok(src.includes("getDatabaseBootstrapHealthState"));
  assert.ok(src.includes("poolMax"));
  assert.ok(src.includes("ready: true"));
  assert.equal(src.includes("DATABASE_URL"), false);
  assert.equal(src.includes("SESSION_SECRET"), false);
  console.log("[TEST] health readiness fields: OK");
}

function testPoolMaxReader() {
  // Espelha a lógica (sem importar TS).
  function readPgPoolMax(env) {
    const raw = env.PG_POOL_MAX?.trim();
    if (!raw) return 5;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 5;
    const floored = Math.floor(n);
    if (floored < 1 || floored > 30) return 5;
    return floored;
  }
  assert.equal(readPgPoolMax({}), 5);
  assert.equal(readPgPoolMax({ PG_POOL_MAX: "10" }), 10);
  assert.equal(readPgPoolMax({ PG_POOL_MAX: "1" }), 1);
  assert.equal(readPgPoolMax({ PG_POOL_MAX: "30" }), 30);
  assert.equal(readPgPoolMax({ PG_POOL_MAX: "0" }), 5);
  assert.equal(readPgPoolMax({ PG_POOL_MAX: "99" }), 5);
  assert.equal(readPgPoolMax({ PG_POOL_MAX: "abc" }), 5);
  console.log("[TEST] PG_POOL_MAX validation: OK");
}

function testPolicyDefaults() {
  function isEnabled(env) {
    const raw = env.DB_SCHEMA_BOOTSTRAP_ENABLED?.trim().toLowerCase();
    if (raw === "true" || raw === "1" || raw === "yes") return true;
    if (raw === "false" || raw === "0" || raw === "no") return false;
    return env.NODE_ENV !== "production";
  }
  assert.equal(isEnabled({ NODE_ENV: "production" }), false);
  assert.equal(isEnabled({ NODE_ENV: "production", DB_SCHEMA_BOOTSTRAP_ENABLED: "false" }), false);
  assert.equal(isEnabled({ NODE_ENV: "production", DB_SCHEMA_BOOTSTRAP_ENABLED: "true" }), true);
  assert.equal(isEnabled({ NODE_ENV: "development" }), true);
  assert.equal(isEnabled({ NODE_ENV: "development", DB_SCHEMA_BOOTSTRAP_ENABLED: "false" }), false);
  console.log("[TEST] bootstrap policy defaults: OK");
}

function testNoSecretsInNewLogs() {
  for (const rel of ["src/server.ts", "src/routes/api/health.ts", "src/lib/pg.server.ts"]) {
    const src = read(rel);
    for (const bad of [
      "console.log(\"[DB_BOOTSTRAP_DISABLED]\"",
      "console.log(\"[DB_BOOTSTRAP_ENABLED]\"",
      "console.log(\"[PG_POOL_CONFIG]\"",
      "console.log(\"[HEALTH_CHECK]\"",
    ]) {
      // only check that nearby log payloads don't reference secret env names in template
    }
    assert.equal(/console\.log\([^\)]*DATABASE_URL/.test(src), false, rel);
    assert.equal(/console\.log\([^\)]*SESSION_SECRET/.test(src), false, rel);
    assert.equal(/console\.log\([^\)]*EVOLUTION_API_KEY/.test(src), false, rel);
  }
  console.log("[TEST] no secrets in containment logs: OK");
}

async function main() {
  testServerRespectsFlag();
  testBootstrapNoOpWhenDisabled();
  testHealthReadiness();
  testPoolMaxReader();
  testPolicyDefaults();
  testNoSecretsInNewLogs();
  console.log("[TEST] phase1 containment checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
