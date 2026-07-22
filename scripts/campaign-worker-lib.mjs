/**
 * Núcleo do poller do worker de campanhas (testável).
 */

export function readWorkerConfig(env = process.env) {
  const appUrl = (env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const secret = env.CAMPAIGN_WORKER_SECRET || "";
  const intervalMs = Number(
    env.CAMPAIGN_WORKER_IDLE_MS || env.WORKER_INTERVAL_MS || 5000,
  );
  const timeoutMs = Number(env.CAMPAIGN_WORKER_TIMEOUT_MS || 60_000);
  const errorDelayMs = Number(env.CAMPAIGN_WORKER_ERROR_DELAY_MS || 10_000);

  return {
    appUrl,
    secret,
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    errorDelayMs: Number.isFinite(errorDelayMs) && errorDelayMs > 0 ? errorDelayMs : 10_000,
  };
}

export function buildTickHeaders(secret) {
  const headers = { "Content-Type": "application/json" };
  if (secret) headers["x-worker-secret"] = secret;
  return headers;
}

export function sanitizeTickLog(data) {
  if (!data || typeof data !== "object") return data;
  const copy = { ...data };
  delete copy.secret;
  delete copy.token;
  return copy;
}

export async function executeWorkerTick(fetchFn, config) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetchFn(`${config.appUrl}/api/campaigns/worker/tick`, {
      method: "POST",
      headers: buildTickHeaders(config.secret),
      signal: controller.signal,
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {
        ok: false,
        success: false,
        action: "error",
        delayMs: config.errorDelayMs,
        message: text.slice(0, 200),
      };
    }

    const durationMs = Date.now() - startedAt;
    const nextDelay =
      typeof data.delayMs === "number" && data.delayMs > 0
        ? data.delayMs
        : config.intervalMs;

    return {
      ok: res.ok,
      status: res.status,
      data,
      durationMs,
      nextDelayMs: nextDelay,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runWorkerLoop(opts) {
  const config = opts.config ?? readWorkerConfig();
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? console.log;
  const logError = opts.logError ?? console.error;
  const shouldStop = opts.shouldStop ?? (() => false);

  log("[CAMPAIGN_WORKER_STARTED]", {
    timestamp: new Date().toISOString(),
    appUrl: config.appUrl,
    hasSecret: !!config.secret,
    intervalMs: config.intervalMs,
    timeoutMs: config.timeoutMs,
  });

  let ticking = false;

  while (!shouldStop()) {
    if (ticking) {
      log("[CAMPAIGN_WORKER_WAITING]", {
        timestamp: new Date().toISOString(),
        reason: "tick_in_progress",
        nextDelayMs: config.intervalMs,
      });
      await sleepFn(config.intervalMs);
      continue;
    }

    ticking = true;
    log("[CAMPAIGN_WORKER_TICK_START]", {
      timestamp: new Date().toISOString(),
    });

    let nextDelayMs = config.intervalMs;
    try {
      const result = await executeWorkerTick(fetchFn, config);
      nextDelayMs = result.nextDelayMs;

      if (result.ok) {
        log("[CAMPAIGN_WORKER_TICK_SUCCESS]", {
          timestamp: new Date().toISOString(),
          httpStatus: result.status,
          durationMs: result.durationMs,
          processed: result.data?.processed ?? null,
          sent: result.data?.sent ?? null,
          failed: result.data?.failed ?? null,
          action: result.data?.action ?? null,
          campaignId: result.data?.campaignId ?? null,
          contactId: result.data?.contactId ?? null,
          nextDelayMs,
          response: sanitizeTickLog(result.data),
        });
      } else {
        logError("[CAMPAIGN_WORKER_TICK_ERROR]", {
          timestamp: new Date().toISOString(),
          httpStatus: result.status,
          durationMs: result.durationMs,
          nextDelayMs,
          response: sanitizeTickLog(result.data),
        });
        nextDelayMs = Math.max(nextDelayMs, config.errorDelayMs);
      }
    } catch (e) {
      const isAbort = e instanceof Error && e.name === "AbortError";
      logError("[CAMPAIGN_WORKER_TICK_ERROR]", {
        timestamp: new Date().toISOString(),
        reason: isAbort ? "timeout" : "network",
        message: e instanceof Error ? e.message : String(e),
        nextDelayMs: config.errorDelayMs,
      });
      nextDelayMs = config.errorDelayMs;
    } finally {
      ticking = false;
    }

    log("[CAMPAIGN_WORKER_WAITING]", {
      timestamp: new Date().toISOString(),
      nextDelayMs,
    });
    await sleepFn(nextDelayMs);
  }
}
