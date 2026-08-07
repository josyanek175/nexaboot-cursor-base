/**
 * Testes do entrypoint/loop do campaign-worker directo.
 * Uso: node scripts/test-campaign-worker-direct.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDirectWorkerConfig,
  buildHealthPayload,
  createWorkerHealthState,
  maskExternalError,
  readDirectWorkerConfig,
  runDirectWorkerLoop,
  sanitizeWorkerLog,
} from "./campaign-worker-direct-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let failed = 0;
function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

// --- config ---
{
  const c = readDirectWorkerConfig({
    CAMPAIGN_WORKER_MODE: "direct",
    CAMPAIGN_WORKER_ENABLED: "true",
  });
  assert("config mode direct", c.mode === "direct");
  assert("config enabled", c.enabled === true);
  assert("config concurrency 1", c.concurrency === 1);
  assert("health off by default", c.healthPort == null);
}

{
  const c = readDirectWorkerConfig({
    CAMPAIGN_WORKER_MODE: "direct",
    CAMPAIGN_WORKER_HEALTH_ENABLED: "true",
  });
  assert("health port default 8081 when enabled", c.healthPort === 8081);
}

{
  let threw = false;
  try {
    assertDirectWorkerConfig(
      readDirectWorkerConfig({ CAMPAIGN_WORKER_MODE: "http", CAMPAIGN_WORKER_ENABLED: "true" }),
    );
  } catch (e) {
    threw = e.code === "invalid_mode";
  }
  assert("rejects mode http in direct process", threw);
}

{
  let threw = false;
  try {
    assertDirectWorkerConfig(
      readDirectWorkerConfig({
        CAMPAIGN_WORKER_MODE: "direct",
        CAMPAIGN_WORKER_CONCURRENCY: "2",
      }),
    );
  } catch (e) {
    threw = e.code === "invalid_concurrency";
  }
  assert("rejects concurrency > 1", threw);
}

{
  let threw = false;
  try {
    assertDirectWorkerConfig(
      readDirectWorkerConfig({
        CAMPAIGN_WORKER_MODE: "direct",
        CAMPAIGN_WORKER_ENABLED: "false",
      }),
    );
  } catch (e) {
    threw = e.code === "worker_disabled";
  }
  assert("rejects enabled=false", threw);
}

assert(
  "mask strips bearer",
  !maskExternalError(new Error("Bearer abc.def.ghi failed")).includes("abc.def"),
);
assert(
  "sanitize removes phone/message",
  sanitizeWorkerLog({ phone: "551199999", message: "oi", action: "sent" }).phone === undefined &&
    sanitizeWorkerLog({ phone: "551199999", message: "oi", action: "sent" }).message === undefined,
);

{
  const state = createWorkerHealthState();
  state.tickInProgress = true;
  state.lastTickResult = "idle";
  const payload = buildHealthPayload(state);
  assert("health ok", payload.ok === true);
  assert("health service name", payload.service === "nexaboot-campaign-worker");
  assert("health no db fields", !("db" in payload) && !("campaigns" in payload));
}

// --- single-flight: dois ticks não simultâneos ---
{
  let active = 0;
  let maxActive = 0;
  let ticks = 0;
  /** @type {null | ((r?: string, c?: number) => void)} */
  let stop = null;

  const loopPromise = runDirectWorkerLoop({
    onSignals: false,
    onReady: ({ requestStop }) => {
      stop = requestStop;
    },
    config: {
      enabled: true,
      mode: "direct",
      concurrency: 1,
      idleMs: 5,
      errorDelayMs: 5,
      shutdownTimeoutMs: 2000,
      healthEnabled: false,
      healthPort: null,
    },
    sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    tickFn: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      ticks += 1;
      await new Promise((r) => setTimeout(r, 25));
      active -= 1;
      if (ticks >= 3 && stop) stop("test_done", 0);
      return { ok: true, action: "idle", delayMs: 5 };
    },
    closePoolFn: async () => {},
    log: () => {},
    logError: () => {},
  });

  const result = await loopPromise;
  assert("single-flight maxActive=1", maxActive === 1);
  assert("single-flight ran ticks", ticks >= 2);
  assert("loop exit 0", result.exitCode === 0);
}

// --- SIGTERM encerra loop e pool ---
{
  let poolClosed = false;
  let ticks = 0;
  /** @type {null | ((r?: string, c?: number) => void)} */
  let stop = null;

  const loopPromise = runDirectWorkerLoop({
    onSignals: false,
    onReady: ({ requestStop }) => {
      stop = requestStop;
    },
    config: {
      enabled: true,
      mode: "direct",
      concurrency: 1,
      idleMs: 50,
      errorDelayMs: 50,
      shutdownTimeoutMs: 2000,
      healthEnabled: false,
      healthPort: null,
    },
    sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)),
    tickFn: async () => {
      ticks += 1;
      if (ticks === 1 && stop) {
        // simula SIGTERM após primeiro tick
        queueMicrotask(() => stop("SIGTERM", 0));
      }
      return { ok: true, action: "sent", delayMs: 5000 };
    },
    closePoolFn: async () => {
      poolClosed = true;
    },
    log: () => {},
    logError: () => {},
  });

  const result = await loopPromise;
  assert("sigterm closes pool", poolClosed === true);
  assert("sigterm exit 0", result.exitCode === 0);
  assert("sigterm interrupted long sleep", ticks === 1);
}

// --- entrypoint static checks ---
const entry = readFileSync(join(root, "scripts/campaign-worker-direct.mjs"), "utf8");
assert("entrypoint does not import src/server.ts", !/from ["'].*src\/server/.test(entry));
assert("entrypoint does not import server.ts path", !entry.includes('server.ts"') || !entry.includes("../src/server"));
assert(
  "entrypoint no server import (strict)",
  !entry.includes("src/server.ts") || entry.includes("NÃO importa src/server.ts"),
);
// strip comments for stricter check
const entryCode = entry
  .split("\n")
  .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
  .join("\n");
assert(
  "entrypoint code has no server.ts import",
  !entryCode.includes("src/server.ts") && !entryCode.includes("/server.ts"),
);
assert("entrypoint imports pg-worker", entry.includes("pg-worker.server.ts"));
assert("entrypoint imports campaign-worker.server", entry.includes("campaign-worker.server.ts"));
assert("entrypoint does not import pg.server", !entry.includes("pg.server"));
assert("entrypoint uses processCampaignWorkerTick({ sql })", entry.includes("processCampaignWorkerTick({ sql })"));

// Statement timeout só no pg-worker (não no web pool)
{
  const { readCampaignWorkerStatementTimeoutMs } = await import(
    "../src/lib/pg-worker.server.ts"
  );
  assert(
    "statement timeout default 15000 (direct suite)",
    readCampaignWorkerStatementTimeoutMs({}) === 15_000,
  );
  assert(
    "statement timeout custom (direct suite)",
    readCampaignWorkerStatementTimeoutMs({ CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS: "30000" }) ===
      30_000,
  );
  assert(
    "statement timeout invalid → default (direct suite)",
    readCampaignWorkerStatementTimeoutMs({ CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS: "nope" }) ===
      15_000,
  );
  const pgWorkerSrc = readFileSync(join(root, "src/lib/pg-worker.server.ts"), "utf8");
  const pgWebSrc = readFileSync(join(root, "src/lib/pg.server.ts"), "utf8");
  assert(
    "statement timeout wired only in pg-worker",
    pgWorkerSrc.includes("CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS") &&
      !pgWebSrc.includes("CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS"),
  );
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert(
  "npm script campaign:worker:direct",
  pkg.scripts["campaign:worker:direct"]?.includes("campaign-worker-direct.mjs"),
);

// Sem migrations nesta entrega
const { execSync } = await import("node:child_process");
const changed = execSync("git status --porcelain", { cwd: root, encoding: "utf8" });
assert(
  "no migration files staged/untracked in scripts/migrations",
  !changed.split("\n").some((l) => /scripts\/migrations\//.test(l) && /^[AM?]/.test(l.trim())),
);

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll campaign-worker-direct tests passed");
