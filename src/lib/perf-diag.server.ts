/**
 * Diagnóstico temporário de performance (Atendimento / rotas quentes).
 *
 * Ativar: PERFORMANCE_DIAGNOSTICS=true
 * Desligar: remover a flag ou qualquer valor ≠ "true".
 *
 * Não persiste métricas, não adiciona deps, não loga PII/SQL/payloads.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const SLOW_MS = 300;
const SAMPLE_INTERVAL_MS = 30_000;

export function isPerfDiagEnabled(): boolean {
  return process.env.PERFORMANCE_DIAGNOSTICS === "true";
}

type PerfStore = {
  requestId: string;
  route: string;
  method: string;
  companyId: string | null;
  userId: string | null;
  dbMs: number;
  externalMs: number;
  resultCount: number | null;
  bytesPerResultHint: number;
  t0: number;
};

const als = new AsyncLocalStorage<PerfStore>();
const lastSampleByRoute = new Map<string, number>();

export type PerfHelpers = {
  setResultCount: (n: number) => void;
  /** Envolve uma consulta já existente; soma em dbMs; loga [DB_SLOW_QUERY] se >= 300ms. */
  timedDb: <T>(queryName: string, run: () => Promise<T>) => Promise<T>;
  /** Envolve chamada externa já existente; soma em externalMs. */
  timedExternal: <T>(name: string, run: () => Promise<T>) => Promise<T>;
};

const NOOP_HELPERS: PerfHelpers = {
  setResultCount() {},
  timedDb: (_n, run) => run(),
  timedExternal: (_n, run) => run(),
};

function shouldEmitApiTiming(route: string, totalMs: number): boolean {
  if (totalMs >= SLOW_MS) return true;
  const now = Date.now();
  const last = lastSampleByRoute.get(route) ?? 0;
  if (now - last < SAMPLE_INTERVAL_MS) return false;
  lastSampleByRoute.set(route, now);
  return true;
}

function cheapResponseBytes(store: PerfStore, response: Response): number | null {
  const cl = response.headers.get("content-length");
  if (cl && /^\d+$/.test(cl)) return Number(cl);
  if (store.resultCount != null && store.resultCount >= 0) {
    // Estimativa barata — não serializa o body.
    return store.resultCount * store.bytesPerResultHint;
  }
  return null;
}

function emitLater(label: string, payload: Record<string, unknown>): void {
  const run = () => {
    try {
      console.log(label, payload);
    } catch {
      /* ignore logging failures */
    }
  };
  if (typeof setImmediate === "function") setImmediate(run);
  else queueMicrotask(run);
}

/**
 * Instrumenta um handler HTTP. Com flag off: um if + call-through (sem ALS).
 */
export async function withApiTiming(
  meta: {
    route: string;
    method: string;
    companyId?: string | null;
    userId?: string | null;
    /** Bytes médios estimados por item quando Content-Length ausente. */
    bytesPerResultHint?: number;
  },
  handler: (perf: PerfHelpers) => Promise<Response>,
): Promise<Response> {
  if (!isPerfDiagEnabled()) {
    return handler(NOOP_HELPERS);
  }

  const store: PerfStore = {
    requestId: randomUUID(),
    route: meta.route,
    method: meta.method,
    companyId: meta.companyId ?? null,
    userId: meta.userId ?? null,
    dbMs: 0,
    externalMs: 0,
    resultCount: null,
    bytesPerResultHint: meta.bytesPerResultHint ?? 256,
    t0: performance.now(),
  };

  return als.run(store, async () => {
    const helpers: PerfHelpers = {
      setResultCount(n) {
        store.resultCount = n;
      },
      timedDb: timedDbImpl,
      timedExternal: timedExternalImpl,
    };

    let response: Response;
    let success = true;
    try {
      response = await handler(helpers);
      success = response.ok;
    } catch (e) {
      const totalMs = Math.round(performance.now() - store.t0);
      const processingMs = Math.max(0, totalMs - store.dbMs - store.externalMs);
      emitLater("[API_TIMING]", {
        requestId: store.requestId,
        route: store.route,
        method: store.method,
        companyId: store.companyId,
        userId: store.userId,
        dbMs: Math.round(store.dbMs),
        externalMs: Math.round(store.externalMs),
        processingMs,
        totalMs,
        resultCount: store.resultCount,
        responseBytes: null,
        status: 500,
        success: false,
      });
      throw e;
    }

    const totalMs = Math.round(performance.now() - store.t0);
    if (shouldEmitApiTiming(store.route, totalMs)) {
      const processingMs = Math.max(0, totalMs - store.dbMs - store.externalMs);
      emitLater("[API_TIMING]", {
        requestId: store.requestId,
        route: store.route,
        method: store.method,
        companyId: store.companyId,
        userId: store.userId,
        dbMs: Math.round(store.dbMs),
        externalMs: Math.round(store.externalMs),
        processingMs,
        totalMs,
        resultCount: store.resultCount,
        responseBytes: cheapResponseBytes(store, response),
        status: response.status,
        success,
      });
    }

    return response;
  });
}

async function timedDbImpl<T>(queryName: string, run: () => Promise<T>): Promise<T> {
  const store = als.getStore();
  if (!store) return run();

  const t0 = performance.now();
  const result = await run();
  const durationMs = Math.round(performance.now() - t0);
  store.dbMs += durationMs;

  if (durationMs >= SLOW_MS) {
    const rowCount = Array.isArray(result) ? result.length : null;
    emitLater("[DB_SLOW_QUERY]", {
      requestId: store.requestId,
      route: store.route,
      queryName,
      durationMs,
      rowCount,
    });
  }

  return result;
}

async function timedExternalImpl<T>(_name: string, run: () => Promise<T>): Promise<T> {
  const store = als.getStore();
  if (!store) return run();

  const t0 = performance.now();
  try {
    return await run();
  } finally {
    store.externalMs += Math.round(performance.now() - t0);
  }
}

/** Só para testes unitários do módulo. */
export function __resetPerfDiagSamplingForTests(): void {
  lastSampleByRoute.clear();
}
