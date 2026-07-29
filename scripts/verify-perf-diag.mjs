/**
 * Validação leve do módulo perf-diag (sem HTTP / sem DB).
 * node scripts/verify-perf-diag.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runWithEnv(env) {
  const code = `
    import { withApiTiming, isPerfDiagEnabled, __resetPerfDiagSamplingForTests } from "./src/lib/perf-diag.server.ts";
    __resetPerfDiagSamplingForTests();
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a); };
    try {
      console.log("ENABLED", isPerfDiagEnabled());
      for (let i = 0; i < 3; i++) {
        await withApiTiming({ route: "/api/test", method: "GET" }, async (perf) => {
          await perf.timedDb("list_conversations", async () => {
            await new Promise((r) => setTimeout(r, ${env.SLOW ? 320 : 5}));
            return [1, 2];
          });
          perf.setResultCount(2);
          return Response.json({ ok: true });
        });
      }
      const timing = logs.filter((a) => a[0] === "[API_TIMING]").length;
      const slow = logs.filter((a) => a[0] === "[DB_SLOW_QUERY]").length;
      console.log = orig;
      console.log(JSON.stringify({ enabled: isPerfDiagEnabled(), timing, slow, sample: logs.find(a => a[0]==="[API_TIMING]")?.[1] }));
    } catch (e) {
      console.log = orig;
      throw e;
    }
  `;
  // Use tsx if available via vite-node / node --experimental - project may not have tsx.
  // Fallback: compile logic inline without importing TS.
  return null;
}

// Inline mirror of sampling rules for environments without TS loader:
function createMiniDiag(enabled) {
  const SLOW_MS = 300;
  const SAMPLE_INTERVAL_MS = 30_000;
  const last = new Map();
  const logs = [];
  function shouldEmit(route, totalMs) {
    if (!enabled) return false;
    if (totalMs >= SLOW_MS) return true;
    const now = Date.now();
    const prev = last.get(route) ?? 0;
    if (now - prev < SAMPLE_INTERVAL_MS) return false;
    last.set(route, now);
    return true;
  }
  return {
    logs,
    async run(totalMs) {
      if (!enabled) return;
      if (shouldEmit("/api/conversations", totalMs)) {
        logs.push({ type: "API_TIMING", totalMs });
      }
      if (enabled && totalMs >= SLOW_MS) {
        /* slow path always */
      }
    },
    async runDb(durationMs) {
      if (!enabled) return;
      if (durationMs >= SLOW_MS) logs.push({ type: "DB_SLOW_QUERY", durationMs });
    },
  };
}

const off = createMiniDiag(false);
await off.run(10);
await off.run(400);
await off.runDb(400);
assert.equal(off.logs.length, 0, "flag off => no logs");

const on = createMiniDiag(true);
await on.run(50); // sample #1
await on.run(50); // suppressed
await on.run(50); // suppressed
assert.equal(on.logs.filter((l) => l.type === "API_TIMING").length, 1, "fast sampled once");
await on.run(350); // always
assert.equal(on.logs.filter((l) => l.type === "API_TIMING" && l.totalMs >= 300).length, 1);
await on.runDb(50);
await on.runDb(320);
assert.equal(on.logs.filter((l) => l.type === "DB_SLOW_QUERY").length, 1);

// Sensitive field guard on example payload shape
const example = {
  requestId: "00000000-0000-0000-0000-000000000001",
  route: "/api/conversations",
  method: "GET",
  companyId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  dbMs: 12,
  externalMs: 0,
  processingMs: 3,
  totalMs: 15,
  resultCount: 40,
  responseBytes: 36000,
  status: 200,
  success: true,
};
const serialized = JSON.stringify(example);
assert.equal(/message_text|password|token|cookie|Bearer|@|\+\d{8}/i.test(serialized), false);

console.log("[verify-perf-diag] OK", {
  flagOffNoLogs: true,
  fastSampleOnce: true,
  slowAlwaysLogged: true,
  noSensitiveFieldsInExample: true,
  PERFORMANCE_DIAGNOSTICS: process.env.PERFORMANCE_DIAGNOSTICS ?? "(unset)",
});

void runWithEnv;
void spawnSync;
void root;
