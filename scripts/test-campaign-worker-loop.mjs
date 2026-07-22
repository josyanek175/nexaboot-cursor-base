/**
 * Testes do loop do campaign worker (fetch mockado).
 * Uso: node scripts/test-campaign-worker-loop.mjs
 */
import {
  buildTickHeaders,
  executeWorkerTick,
  readWorkerConfig,
  runWorkerLoop,
  sanitizeTickLog,
} from "./campaign-worker-lib.mjs";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

// Header com segredo
const headers = buildTickHeaders("super-secret-value");
assert("header x-worker-secret", headers["x-worker-secret"] === "super-secret-value");
assert("header no secret field", !("secret" in headers));

// sanitizeTickLog remove segredo
assert(
  "sanitize removes secret",
  sanitizeTickLog({ secret: "x", processed: 1 }).secret === undefined,
);

// executeWorkerTick success
{
  const fetchCalls = [];
  const fetchFn = async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          processed: 1,
          sent: 1,
          failed: 0,
          action: "sent",
          delayMs: 200,
        }),
    };
  };

  const result = await executeWorkerTick(fetchFn, readWorkerConfig({
    APP_URL: "https://nexaboot.com",
    CAMPAIGN_WORKER_SECRET: "abc123",
    CAMPAIGN_WORKER_IDLE_MS: "5000",
    CAMPAIGN_WORKER_TIMEOUT_MS: "5000",
  }));

  assert("tick url", fetchCalls[0]?.url === "https://nexaboot.com/api/campaigns/worker/tick");
  assert("tick method POST", fetchCalls[0]?.init?.method === "POST");
  assert(
    "tick sends secret header",
    fetchCalls[0]?.init?.headers?.["x-worker-secret"] === "abc123",
  );
  assert("tick http ok", result.ok === true);
  assert("tick processed", result.data?.processed === 1);
}

// HTTP error não encerra loop e segundo tick não sobrepõe o primeiro
{
  let active = 0;
  let maxActive = 0;
  let ticks = 0;
  const logs = [];
  const errors = [];

  const fetchFn = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    ticks += 1;
    await new Promise((r) => setTimeout(r, 30));
    active -= 1;

    if (ticks === 1) {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ success: false, action: "error", delayMs: 20 }),
      };
    }

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ success: true, processed: 0, reason: "nothing_to_process", delayMs: 20 }),
    };
  };

  let stopAfter = 0;
  await runWorkerLoop({
    config: readWorkerConfig({
      APP_URL: "https://nexaboot.com",
      CAMPAIGN_WORKER_SECRET: "abc123",
      CAMPAIGN_WORKER_IDLE_MS: "10",
      CAMPAIGN_WORKER_ERROR_DELAY_MS: "10",
      CAMPAIGN_WORKER_TIMEOUT_MS: "5000",
    }),
    fetchFn,
    sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))),
    log: (...args) => logs.push(args),
    logError: (...args) => errors.push(args),
    shouldStop: () => {
      stopAfter += 1;
      return stopAfter > 2;
    },
  });

  assert("loop survived http 500", ticks >= 2);
  assert("no concurrent ticks", maxActive === 1);
  assert(
    "logs contain tick start",
    logs.some(([tag]) => tag === "[CAMPAIGN_WORKER_TICK_START]"),
  );
  assert(
    "logs contain tick error",
    errors.some(([tag]) => tag === "[CAMPAIGN_WORKER_TICK_ERROR]"),
  );

  const allLogText = JSON.stringify([...logs, ...errors]);
  assert("secret not in logs", !allLogText.includes("abc123"));
  assert("secret not in logs literal", !allLogText.includes("super-secret"));
}

// WORKER_INTERVAL_MS alias
{
  const cfg = readWorkerConfig({ WORKER_INTERVAL_MS: "7777" });
  assert("WORKER_INTERVAL_MS alias", cfg.intervalMs === 7777);
}

console.log(failed === 0 ? "\nAll campaign worker loop tests passed." : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
