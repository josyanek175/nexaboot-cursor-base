/**
 * Núcleo do poller do worker de campanhas (testável).
 */

export function parseTruthyEnv(raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return null;
}

/** Modo do worker. Ausente ou desconhecido → "http" (compatibilidade). */
export function parseWorkerMode(env = process.env) {
  const raw = (env.CAMPAIGN_WORKER_MODE ?? "").trim().toLowerCase();
  if (raw === "direct") return "direct";
  if (raw === "disabled") return "disabled";
  return "http";
}

export function readWorkerConfig(env = process.env) {
  const appUrl = (env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const secret = env.CAMPAIGN_WORKER_SECRET || "";
  const intervalMs = Number(
    env.CAMPAIGN_WORKER_IDLE_MS || env.WORKER_INTERVAL_MS || 5000,
  );
  const timeoutMs = Number(env.CAMPAIGN_WORKER_TIMEOUT_MS || 60_000);
  const errorDelayMs = Number(env.CAMPAIGN_WORKER_ERROR_DELAY_MS || 10_000);
  const enabledParsed = parseTruthyEnv(env.CAMPAIGN_WORKER_ENABLED);

  return {
    appUrl,
    secret,
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    errorDelayMs: Number.isFinite(errorDelayMs) && errorDelayMs > 0 ? errorDelayMs : 10_000,
    mode: parseWorkerMode(env),
    enabled: enabledParsed === null ? true : enabledParsed,
  };
}

/**
 * Decide se o poller HTTP legado deve rodar.
 * Só roda em mode=http (ou ausente) e com CAMPAIGN_WORKER_ENABLED diferente de false.
 */
export function resolveLegacyWorkerGate(config) {
  const mode = config?.mode ?? "http";
  const enabled = config?.enabled !== false;

  if (!enabled) return { run: false, mode, code: "worker_enabled_false" };
  if (mode === "direct") return { run: false, mode, code: "worker_mode_direct" };
  if (mode === "disabled") return { run: false, mode, code: "worker_disabled" };
  return { run: true, mode, code: null };
}

export function shouldLegacyWorkerRun(env = process.env) {
  return resolveLegacyWorkerGate(readWorkerConfig(env));
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

  const gate = opts.gate ?? resolveLegacyWorkerGate(config);
  if (!gate.run) {
    log("[CAMPAIGN_WORKER_LEGACY_SKIPPED]", {
      event: "campaign_worker_legacy_skipped",
      timestamp: new Date().toISOString(),
      mode: gate.mode,
      code: gate.code,
      message: "Poller HTTP legado inativo: nenhum tick sera enviado ao web.",
    });
    return { started: false, mode: gate.mode, code: gate.code };
  }

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

  return { started: true, mode: gate.mode, code: null };
}
