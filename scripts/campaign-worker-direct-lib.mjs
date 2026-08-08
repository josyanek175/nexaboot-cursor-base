/**
 * Núcleo testável do campaign-worker directo (sem HTTP, sem bootstrap web).
 *
 * Não importa src/server.ts nem pg.server.
 */

export function parseTruthyEnv(raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return null;
}

export function readDirectWorkerConfig(env = process.env) {
  const enabledRaw = env.CAMPAIGN_WORKER_ENABLED;
  const enabledParsed = parseTruthyEnv(enabledRaw);
  // Ausente → true (serviço dedicado existe para processar).
  const enabled = enabledParsed === null ? true : enabledParsed;

  const mode = (env.CAMPAIGN_WORKER_MODE ?? "").trim().toLowerCase();

  const concurrencyRaw = env.CAMPAIGN_WORKER_CONCURRENCY?.trim();
  let concurrency = 1;
  if (concurrencyRaw) {
    const n = Number(concurrencyRaw);
    concurrency = Number.isFinite(n) ? Math.floor(n) : NaN;
  }

  const idleMs = Number(env.CAMPAIGN_WORKER_IDLE_MS || env.WORKER_INTERVAL_MS || 5000);
  const errorDelayMs = Number(env.CAMPAIGN_WORKER_ERROR_DELAY_MS || 10_000);
  const shutdownTimeoutMs = Number(env.CAMPAIGN_WORKER_SHUTDOWN_TIMEOUT_MS || 30_000);

  const healthEnabled = parseTruthyEnv(env.CAMPAIGN_WORKER_HEALTH_ENABLED) === true;
  const healthPortRaw = env.CAMPAIGN_WORKER_HEALTH_PORT?.trim();
  const healthPort = healthPortRaw
    ? Number(healthPortRaw)
    : healthEnabled
      ? 8081
      : null;

  return {
    enabled,
    mode,
    concurrency,
    idleMs: Number.isFinite(idleMs) && idleMs > 0 ? idleMs : 5000,
    errorDelayMs: Number.isFinite(errorDelayMs) && errorDelayMs > 0 ? errorDelayMs : 10_000,
    shutdownTimeoutMs:
      Number.isFinite(shutdownTimeoutMs) && shutdownTimeoutMs > 0
        ? shutdownTimeoutMs
        : 30_000,
    healthEnabled,
    healthPort:
      healthEnabled && Number.isFinite(healthPort) && healthPort > 0 && healthPort < 65536
        ? Math.floor(healthPort)
        : null,
  };
}

/**
 * Valida config do processo direct. Lança Error com mensagem clara.
 */
export function assertDirectWorkerConfig(config) {
  if (!config.enabled) {
    const err = new Error(
      "CAMPAIGN_WORKER_ENABLED=false — worker directo não inicia.",
    );
    err.code = "worker_disabled";
    throw err;
  }
  if (config.mode !== "direct") {
    const err = new Error(
      `CAMPAIGN_WORKER_MODE deve ser "direct" neste processo (recebido: "${config.mode || "(ausente)"}"). Default do web é http; o serviço dedicado exige mode=direct.`,
    );
    err.code = "invalid_mode";
    throw err;
  }
  if (config.concurrency !== 1) {
    const err = new Error(
      `CAMPAIGN_WORKER_CONCURRENCY deve ser 1 nesta fase (recebido: ${config.concurrency}). Use uma única réplica EasyPanel.`,
    );
    err.code = "invalid_concurrency";
    throw err;
  }
}

export function maskExternalError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***")
    .replace(/access_token=[^&\s]+/gi, "access_token=***")
    .replace(/api[_-]?key[=:]\s*[^\s,;]+/gi, "api_key=***")
    .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "postgres://***")
    .slice(0, 300);
}

export function sanitizeWorkerLog(data) {
  if (!data || typeof data !== "object") return data;
  const copy = { ...data };
  for (const key of [
    "message",
    "phone",
    "token",
    "accessToken",
    "apiKey",
    "raw_payload",
    "secret",
    "authorization",
    "DATABASE_URL",
    "CAMPAIGN_WORKER_DATABASE_URL",
  ]) {
    delete copy[key];
  }
  if (typeof copy.error === "string") {
    copy.error = maskExternalError(copy.error);
  }
  return copy;
}

/**
 * Estado partilhado do health (sem PostgreSQL).
 */
export function createWorkerHealthState() {
  return {
    running: true,
    tickInProgress: false,
    lastTickAt: null,
    lastTickResult: null,
  };
}

export function buildHealthPayload(state) {
  return {
    ok: true,
    service: "nexaboot-campaign-worker",
    mode: "direct",
    running: Boolean(state.running),
    tickInProgress: Boolean(state.tickInProgress),
    lastTickAt: state.lastTickAt,
    lastTickResult: state.lastTickResult,
  };
}

/**
 * Health HTTP mínimo (opcional). Não consulta PostgreSQL.
 */
export async function startHealthServer({ port, healthState, createServer, log }) {
  const http = createServer ?? (await import("node:http")).default;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url?.startsWith("/health?"))) {
      const body = JSON.stringify(buildHealthPayload(healthState));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, code: "not_found" }));
  });

  await new Promise((resolve, reject) => {
    server.listen(port, () => resolve());
    server.on("error", reject);
  });

  (log ?? console.log)(
    JSON.stringify({
      event: "campaign_worker_health_listen",
      port,
      path: "/health",
    }),
  );

  return server;
}

/**
 * Loop single-flight com shutdown gracioso.
 *
 * @param opts.tickFn async () => { action, delayMs, ... }
 * @param opts.closePoolFn async () => void
 */
export async function runDirectWorkerLoop(opts) {
  const config = opts.config ?? readDirectWorkerConfig();
  assertDirectWorkerConfig(config);

  const tickFn = opts.tickFn;
  if (typeof tickFn !== "function") {
    throw new Error("tickFn obrigatório");
  }

  const sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((msg) => console.log(msg));
  const logError = opts.logError ?? ((msg) => console.error(msg));
  const healthState = opts.healthState ?? createWorkerHealthState();
  const closePoolFn = opts.closePoolFn ?? (async () => {});
  const onSignals = opts.onSignals !== false;

  let stopping = false;
  let ticking = false;
  /** @type {Promise<{ nextDelayMs: number }> | null} */
  let currentTickPromise = null;
  let exitCode = 0;
  /** @type {(() => void) | null} */
  let wakeFromSleep = null;

  const requestStop = (reason, code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    healthState.running = false;
    log(
      JSON.stringify({
        event: "campaign_worker_shutdown_requested",
        reason,
        exitCode: code,
      }),
    );
    if (wakeFromSleep) wakeFromSleep();
  };

  opts.onReady?.({ requestStop });

  if (onSignals && typeof process !== "undefined" && process.on) {
    process.on("SIGTERM", () => requestStop("SIGTERM", 0));
    process.on("SIGINT", () => requestStop("SIGINT", 0));
  }

  const interruptibleSleep = async (ms) => {
    if (stopping) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        wakeFromSleep = null;
        resolve();
      }, ms);
      wakeFromSleep = () => {
        clearTimeout(t);
        wakeFromSleep = null;
        resolve();
      };
    });
  };

  log(
    JSON.stringify({
      event: "campaign_worker_direct_started",
      mode: "direct",
      concurrency: 1,
      idleMs: config.idleMs,
      errorDelayMs: config.errorDelayMs,
      healthPort: config.healthPort,
    }),
  );

  while (!stopping) {
    // Single-flight: um tick de cada vez (ticking impede reentrada).
    if (ticking) {
      await interruptibleSleep(config.idleMs);
      continue;
    }

    ticking = true;
    healthState.tickInProgress = true;

    currentTickPromise = (async () => {
      try {
        const result = await tickFn();
        const action = result?.action ?? "idle";
        healthState.lastTickAt = new Date().toISOString();
        healthState.lastTickResult =
          action === "sent" || action === "failed" || action === "error" || action === "idle"
            ? action
            : String(action);

        const nextDelay =
          typeof result?.delayMs === "number" && result.delayMs > 0
            ? result.delayMs
            : config.idleMs;

        log(
          JSON.stringify({
            event: "campaign_worker_tick_ok",
            action: healthState.lastTickResult,
            delayMs: nextDelay,
            campaignId: result?.campaignId ?? null,
            contactId: result?.contactId ?? null,
            ok: result?.ok !== false,
          }),
        );

        return { nextDelayMs: nextDelay };
      } catch (e) {
        healthState.lastTickAt = new Date().toISOString();
        healthState.lastTickResult = "error";
        logError(
          JSON.stringify({
            event: "campaign_worker_tick_error",
            error: maskExternalError(e),
            delayMs: config.errorDelayMs,
          }),
        );
        return { nextDelayMs: config.errorDelayMs };
      }
    })();

    let nextDelayMs = config.idleMs;
    try {
      const outcome = await currentTickPromise;
      nextDelayMs = outcome.nextDelayMs;
    } finally {
      ticking = false;
      healthState.tickInProgress = false;
      currentTickPromise = null;
    }

    if (stopping) break;
    await interruptibleSleep(nextDelayMs);
  }

  // Se ainda houver tick (race com signal), aguarda com timeout.
  if (currentTickPromise) {
    const timedOut = await Promise.race([
      currentTickPromise.then(() => false),
      sleepFn(config.shutdownTimeoutMs).then(() => true),
    ]);
    if (timedOut) {
      exitCode = exitCode || 1;
      logError(
        JSON.stringify({
          event: "campaign_worker_shutdown_tick_timeout",
          shutdownTimeoutMs: config.shutdownTimeoutMs,
        }),
      );
    }
  }

  try {
    await closePoolFn();
    log(JSON.stringify({ event: "campaign_worker_pool_closed" }));
  } catch (e) {
    exitCode = exitCode || 1;
    logError(
      JSON.stringify({
        event: "campaign_worker_pool_close_error",
        error: maskExternalError(e),
      }),
    );
  }

  log(
    JSON.stringify({
      event: "campaign_worker_direct_stopped",
      exitCode,
    }),
  );

  return { exitCode, requestStop };
}
