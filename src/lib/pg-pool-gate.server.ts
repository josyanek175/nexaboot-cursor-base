/**
 * Gate de concorrência sobre o pool postgres.js.
 * Evita espera indefinida por slot (sintoma: /api/auth/me Pending).
 * Contadores aproximam totalCount / idleCount / waitingCount (postgres.js não expõe node-pg).
 *
 * Não importa pg.server (evita ciclo). Lê PG_POOL_MAX do env com a mesma regra.
 */

function readPgPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PG_POOL_MAX?.trim();
  if (!raw) return 5;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  const floored = Math.floor(n);
  if (floored < 1 || floored > 30) return 5;
  return floored;
}

const POOL_MAX = readPgPoolMax();

export class PoolAcquireTimeoutError extends Error {
  readonly clientCode = "pool_acquire_timeout" as const;
  readonly origin: string;
  readonly waitedMs: number;

  constructor(origin: string, waitedMs: number) {
    super("pool_acquire_timeout");
    this.name = "PoolAcquireTimeoutError";
    this.origin = origin;
    this.waitedMs = waitedMs;
  }
}

export function isPoolAcquireTimeout(error: unknown): error is PoolAcquireTimeoutError {
  return (
    error instanceof PoolAcquireTimeoutError ||
    (error instanceof Error && error.message === "pool_acquire_timeout")
  );
}

/** Cap do gate = tamanho do pool (1 conexão lógica por slot). */
export function getPoolGateMax(envMax: number = POOL_MAX): number {
  return Math.max(1, envMax);
}

/** Webhooks: no máximo metade do pool (mín. 2), reservando o resto para UI/me. */
export function getWebhookConcurrencyMax(envMax: number = POOL_MAX): number {
  return Math.max(2, Math.floor(envMax / 2));
}

type Waiter = {
  origin: string;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
};

let _inUse = 0;
let _waiters: Waiter[] = [];
let _webhookInUse = 0;
let _webhookWaiters: Waiter[] = [];

export function getPoolGateMetrics() {
  const totalCount = getPoolGateMax();
  return {
    totalCount,
    idleCount: Math.max(0, totalCount - _inUse),
    waitingCount: _waiters.length,
    activeCount: _inUse,
    webhookActive: _webhookInUse,
    webhookWaiting: _webhookWaiters.length,
    webhookMax: getWebhookConcurrencyMax(),
  };
}

export function logPoolGateStatus(tag = "PG_POOL_STATUS"): void {
  const m = getPoolGateMetrics();
  console.log(`[${tag}]`, {
    totalCount: m.totalCount,
    idleCount: m.idleCount,
    waitingCount: m.waitingCount,
    activeCount: m.activeCount,
    webhookActive: m.webhookActive,
    webhookWaiting: m.webhookWaiting,
    webhookMax: m.webhookMax,
    poolMax: POOL_MAX,
  });
}

function acquireGeneric(
  kind: "pool" | "webhook",
  origin: string,
  timeoutMs: number,
): Promise<void> {
  const max = kind === "webhook" ? getWebhookConcurrencyMax() : getPoolGateMax();
  const getInUse = () => (kind === "webhook" ? _webhookInUse : _inUse);
  const setInUse = (n: number) => {
    if (kind === "webhook") _webhookInUse = n;
    else _inUse = n;
  };
  const getWaiters = () => (kind === "webhook" ? _webhookWaiters : _waiters);
  const setWaiters = (w: Waiter[]) => {
    if (kind === "webhook") _webhookWaiters = w;
    else _waiters = w;
  };

  if (getInUse() < max) {
    setInUse(getInUse() + 1);
    return Promise.resolve();
  }

  const startedAt = Date.now();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      setWaiters(getWaiters().filter((w) => w.timer !== timer));
      reject(new PoolAcquireTimeoutError(origin, Date.now() - startedAt));
    }, Math.max(1, timeoutMs));

    const list = getWaiters();
    list.push({
      origin,
      resolve: () => {
        clearTimeout(timer);
        // Slot transferido do liberador — inUse permanece.
        resolve();
      },
      reject,
      timer,
      startedAt,
    });
    setWaiters(list);
  });
}

function releaseGeneric(kind: "pool" | "webhook"): void {
  const getInUse = () => (kind === "webhook" ? _webhookInUse : _inUse);
  const setInUse = (n: number) => {
    if (kind === "webhook") _webhookInUse = n;
    else _inUse = n;
  };
  const getWaiters = () => (kind === "webhook" ? _webhookWaiters : _waiters);
  const setWaiters = (w: Waiter[]) => {
    if (kind === "webhook") _webhookWaiters = w;
    else _waiters = w;
  };

  const list = getWaiters();
  const next = list.shift();
  setWaiters(list);
  if (next) {
    next.resolve();
    return;
  }
  setInUse(Math.max(0, getInUse() - 1));
}

export async function acquirePoolGateSlot(origin: string, timeoutMs: number): Promise<void> {
  await acquireGeneric("pool", origin, timeoutMs);
}

export function releasePoolGateSlot(): void {
  releaseGeneric("pool");
}

/**
 * Adquire slot do gate e garante release em finally.
 * Usar em /api/auth/me e health DB probe — não abandona espera do postgres.js.
 */
export async function withPoolGateSlot<T>(
  origin: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await acquirePoolGateSlot(origin, timeoutMs);
  try {
    return await fn();
  } finally {
    releasePoolGateSlot();
  }
}

export async function withWebhookConcurrencyLimit<T>(
  origin: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireGeneric("webhook", origin, timeoutMs);
  try {
    return await fn();
  } finally {
    releaseGeneric("webhook");
  }
}

/** Timeout padrão para adquirir slot de webhook (ms). */
export const WEBHOOK_ACQUIRE_TIMEOUT_MS = 5_000;

/** Executa handler de webhook com limite; 503 se pool de webhooks saturado. */
export async function runWebhookWithConcurrencyLimit(
  origin: string,
  fn: () => Promise<Response>,
  timeoutMs: number = WEBHOOK_ACQUIRE_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await withWebhookConcurrencyLimit(origin, timeoutMs, fn);
  } catch (e) {
    if (isPoolAcquireTimeout(e)) {
      logPoolGateStatus("PG_POOL_STATUS_WEBHOOK_BUSY");
      console.warn("[WEBHOOK_CONCURRENCY_LIMIT]", {
        origin,
        waitedMs: e.waitedMs,
        ...getPoolGateMetrics(),
      });
      return Response.json(
        { error: "webhook_busy", retryable: true },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    throw e;
  }
}

/** Só testes. */
export function __resetPoolGateForTests(): void {
  _inUse = 0;
  _waiters.forEach((w) => clearTimeout(w.timer));
  _waiters = [];
  _webhookInUse = 0;
  _webhookWaiters.forEach((w) => clearTimeout(w.timer));
  _webhookWaiters = [];
}

export function __getPoolGateInUseForTests(): number {
  return _inUse;
}

export function __getPoolGateWaitingForTests(): number {
  return _waiters.length;
}
