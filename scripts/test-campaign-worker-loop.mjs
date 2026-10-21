/**
 * Testes do loop do campaign worker (fetch mockado).
 * Uso: node scripts/test-campaign-worker-loop.mjs
 */
import { readFileSync } from "node:fs";

import {
  buildTickHeaders,
  executeWorkerTick,
  parseWorkerMode,
  readWorkerConfig,
  resolveLegacyWorkerGate,
  runWorkerLoop,
  sanitizeTickLog,
  shouldLegacyWorkerRun,
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

// loop continua após action=sent com delayMs longo (pausa segura)
{
  let ticks = 0;
  const delays = [];
  const fetchFn = async () => {
    ticks += 1;
    if (ticks === 1) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            action: "sent",
            delayMs: 11_008,
            processed: 1,
            sent: 1,
          }),
      };
    }
    if (ticks === 2) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            action: "sent",
            delayMs: 200,
            processed: 1,
            sent: 1,
          }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          action: "idle",
          delayMs: 5_000,
          reason: "nothing_to_process",
        }),
    };
  };

  let stopAfter = 0;
  await runWorkerLoop({
    config: readWorkerConfig({
      APP_URL: "https://nexaboot.com",
      CAMPAIGN_WORKER_IDLE_MS: "5",
      CAMPAIGN_WORKER_TIMEOUT_MS: "5000",
    }),
    fetchFn,
    sleepFn: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    log: () => {},
    logError: () => {},
    shouldStop: () => {
      stopAfter += 1;
      return stopAfter > 2;
    },
  });

  assert("continues after sent delay", ticks >= 2);
  assert("uses sent delayMs", delays[0] === 11_008);
  assert("second tick uses next delayMs", delays[1] === 200);
}

// --- Gate do poller legado por CAMPAIGN_WORKER_MODE / CAMPAIGN_WORKER_ENABLED ---

// parseWorkerMode
assert("mode ausente vira http", parseWorkerMode({}) === "http");
assert("mode vazio vira http", parseWorkerMode({ CAMPAIGN_WORKER_MODE: "  " }) === "http");
assert("mode http", parseWorkerMode({ CAMPAIGN_WORKER_MODE: "http" }) === "http");
assert("mode direct", parseWorkerMode({ CAMPAIGN_WORKER_MODE: "direct" }) === "direct");
assert("mode disabled", parseWorkerMode({ CAMPAIGN_WORKER_MODE: "disabled" }) === "disabled");
assert("mode case-insensitive", parseWorkerMode({ CAMPAIGN_WORKER_MODE: " DiReCt " }) === "direct");
assert("mode desconhecido vira http", parseWorkerMode({ CAMPAIGN_WORKER_MODE: "wat" }) === "http");

// readWorkerConfig expõe mode/enabled
{
  const cfg = readWorkerConfig({});
  assert("config default mode http", cfg.mode === "http");
  assert("config default enabled true", cfg.enabled === true);

  assert("config enabled false", readWorkerConfig({ CAMPAIGN_WORKER_ENABLED: "false" }).enabled === false);
  assert("config enabled 0", readWorkerConfig({ CAMPAIGN_WORKER_ENABLED: "0" }).enabled === false);
  assert("config enabled no", readWorkerConfig({ CAMPAIGN_WORKER_ENABLED: "no" }).enabled === false);
  assert("config enabled true explicito", readWorkerConfig({ CAMPAIGN_WORKER_ENABLED: "true" }).enabled === true);
  assert("config enabled invalido vira true", readWorkerConfig({ CAMPAIGN_WORKER_ENABLED: "talvez" }).enabled === true);
}

// resolveLegacyWorkerGate / shouldLegacyWorkerRun
{
  assert("gate roda sem env", shouldLegacyWorkerRun({}).run === true);
  assert("gate roda em http", shouldLegacyWorkerRun({ CAMPAIGN_WORKER_MODE: "http" }).run === true);

  const direct = shouldLegacyWorkerRun({ CAMPAIGN_WORKER_MODE: "direct" });
  assert("gate bloqueia direct", direct.run === false);
  assert("gate code direct", direct.code === "worker_mode_direct");

  const disabled = shouldLegacyWorkerRun({ CAMPAIGN_WORKER_MODE: "disabled" });
  assert("gate bloqueia disabled", disabled.run === false);
  assert("gate code disabled", disabled.code === "worker_disabled");

  const offEnv = shouldLegacyWorkerRun({ CAMPAIGN_WORKER_ENABLED: "false" });
  assert("gate bloqueia enabled=false", offEnv.run === false);
  assert("gate code enabled=false", offEnv.code === "worker_enabled_false");

  assert(
    "enabled=false vence mode=http",
    shouldLegacyWorkerRun({ CAMPAIGN_WORKER_MODE: "http", CAMPAIGN_WORKER_ENABLED: "false" }).run === false,
  );
  assert("gate default sem config", resolveLegacyWorkerGate(undefined).run === true);
}

// runWorkerLoop não faz fetch quando o gate bloqueia
for (const [label, env, expectedCode] of [
  ["direct", { CAMPAIGN_WORKER_MODE: "direct" }, "worker_mode_direct"],
  ["disabled", { CAMPAIGN_WORKER_MODE: "disabled" }, "worker_disabled"],
  ["enabled=false", { CAMPAIGN_WORKER_ENABLED: "false" }, "worker_enabled_false"],
]) {
  let fetchCount = 0;
  let sleepCount = 0;
  const logs = [];
  const errors = [];

  const outcome = await runWorkerLoop({
    config: readWorkerConfig({ APP_URL: "https://nexaboot.com", ...env }),
    fetchFn: async () => {
      fetchCount += 1;
      throw new Error("fetch nao deveria ser chamado");
    },
    sleepFn: async () => {
      sleepCount += 1;
    },
    log: (...args) => logs.push(args),
    logError: (...args) => errors.push(args),
  });

  assert(`${label}: nenhum fetch`, fetchCount === 0);
  assert(`${label}: nenhum sleep`, sleepCount === 0);
  assert(`${label}: retorna started=false`, outcome?.started === false);
  assert(`${label}: retorna code`, outcome?.code === expectedCode);
  assert(`${label}: nenhum erro logado`, errors.length === 0);
  assert(`${label}: log unico`, logs.length === 1);
  assert(`${label}: tag do log`, logs[0]?.[0] === "[CAMPAIGN_WORKER_LEGACY_SKIPPED]");
  assert(`${label}: event do log`, logs[0]?.[1]?.event === "campaign_worker_legacy_skipped");
  assert(
    `${label}: nao loga CAMPAIGN_WORKER_STARTED`,
    !logs.some(([tag]) => tag === "[CAMPAIGN_WORKER_STARTED]"),
  );
}

// runWorkerLoop roda normalmente sem CAMPAIGN_WORKER_MODE (compatibilidade)
{
  let fetchCount = 0;
  const logs = [];
  let stopAfter = 0;

  const outcome = await runWorkerLoop({
    config: readWorkerConfig({ APP_URL: "https://nexaboot.com", CAMPAIGN_WORKER_IDLE_MS: "5" }),
    fetchFn: async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, action: "idle", delayMs: 5 }),
      };
    },
    sleepFn: () => Promise.resolve(),
    log: (...args) => logs.push(args),
    logError: () => {},
    shouldStop: () => {
      stopAfter += 1;
      return stopAfter > 1;
    },
  });

  assert("mode ausente: faz tick", fetchCount >= 1);
  assert("mode ausente: retorna started=true", outcome?.started === true);
  assert(
    "mode ausente: loga CAMPAIGN_WORKER_STARTED",
    logs.some(([tag]) => tag === "[CAMPAIGN_WORKER_STARTED]"),
  );
  assert(
    "mode ausente: nao loga skipped",
    !logs.some(([tag]) => tag === "[CAMPAIGN_WORKER_LEGACY_SKIPPED]"),
  );
}

// Entrypoint: fica ocioso em vez de sair, evitando restart-loop
{
  const entry = readFileSync(new URL("./campaign-worker.mjs", import.meta.url), "utf8");
  assert("entrypoint usa runWorkerLoop", entry.includes("runWorkerLoop"));
  assert("entrypoint faz park quando inativo", entry.includes("parkUntilSignal"));
  assert("entrypoint nao sai com erro", !entry.includes("process.exit(1)"));
  assert("entrypoint trata SIGTERM", entry.includes("SIGTERM"));
  assert("entrypoint trata SIGINT", entry.includes("SIGINT"));
  assert("entrypoint nao chama fetch direto", !entry.includes("fetch("));
  assert(
    "entrypoint faz park apenas quando started=false",
    /started === false[\s\S]*parkUntilSignal\(\)/.test(entry),
  );
}

console.log(failed === 0 ? "\nAll campaign worker loop tests passed." : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
