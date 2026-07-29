/**
 * Diagnóstico temporário de hangs em GET /api/auth/me.
 * Não altera SQL, sessão, auth ou permissões — só timeout + métricas.
 */
import {
  getDatabaseRuntimeDiag,
  reserveSqlConnection,
} from "@/lib/pg.server";

export const ME_DB_STEP_TIMEOUT_MS = 5_000;

export class AuthContextTimeoutError extends Error {
  readonly clientCode = "auth_context_timeout" as const;
  readonly step: string;
  readonly connectionWaitMs: number | null;
  readonly queryMs: number | null;

  constructor(
    step: string,
    opts?: { connectionWaitMs?: number | null; queryMs?: number | null },
  ) {
    super("auth_context_timeout");
    this.name = "AuthContextTimeoutError";
    this.step = step;
    this.connectionWaitMs = opts?.connectionWaitMs ?? null;
    this.queryMs = opts?.queryMs ?? null;
  }
}

export function isAuthContextTimeout(
  error: unknown,
): error is AuthContextTimeoutError {
  return (
    error instanceof AuthContextTimeoutError ||
    (error instanceof Error && error.message === "auth_context_timeout")
  );
}

export function authContextTimeoutResponse(): Response {
  return Response.json({ error: "auth_context_timeout" }, { status: 503 });
}

function rejectAfter(
  ms: number,
  step: string,
  meta?: { connectionWaitMs?: number | null; queryMs?: number | null },
): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new AuthContextTimeoutError(step, meta));
    }, ms);
  });
}

/** Promise.race com timeout de diagnóstico (5s). */
export async function withMeDbTimeout<T>(
  step: string,
  promise: Promise<T>,
  meta?: { connectionWaitMs?: number | null; queryMs?: number | null },
): Promise<T> {
  return Promise.race([
    promise,
    rejectAfter(ME_DB_STEP_TIMEOUT_MS, step, meta),
  ]);
}

/**
 * Se Promise.race desistir, a reserve() original ainda pode completar depois.
 * Sem este release, o slot do pool (max:5) vaza para sempre.
 * - resolve tardio → release() exatamente uma vez (por Promise)
 * - reject tardio → sem unhandledRejection
 * - não guarda referência global
 */
const _lateReleaseAttached = new WeakSet<Promise<unknown>>();

function releaseReserveWhenReady(
  reservePromise: Promise<{ release: () => void }>,
): void {
  if (_lateReleaseAttached.has(reservePromise)) return;
  _lateReleaseAttached.add(reservePromise);
  void reservePromise.then(
    (r) => {
      try {
        r.release();
      } catch {
        /* ignore */
      }
    },
    () => {
      // reject tardio: sem conexão
    },
  );
}

export type MeUserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  tenant_id: string;
  active: boolean;
};

/**
 * Mesmo SELECT de /me, com medição separada:
 * connectionWaitMs (reserve) vs queryMs (execução).
 * Libera a conexão no finally — não altera o SQL.
 */
export async function meUserQueryWithConnectionTiming(
  uid: string,
  requestId: string,
): Promise<{
  rows: MeUserRow[];
  connectionWaitMs: number;
  queryMs: number;
}> {
  console.log("[ME_STEP_USER_QUERY_START]", {
    requestId,
    ...getDatabaseRuntimeDiag(),
  });

  const tConn0 = Date.now();
  let connectionWaitMs = 0;
  let reserved: Awaited<ReturnType<typeof reserveSqlConnection>> | null = null;
  const reservePromise = reserveSqlConnection();

  try {
    try {
      reserved = await withMeDbTimeout("user_query_connection", reservePromise, {
        connectionWaitMs: 0,
        queryMs: null,
      });
    } catch (err) {
      releaseReserveWhenReady(reservePromise);
      throw err;
    }
    connectionWaitMs = Date.now() - tConn0;

    const tQuery0 = Date.now();
    // Mesmo SQL de me.ts — apenas via sessão reservada para separar wait vs query.
    const rows = await withMeDbTimeout(
      "user_query",
      reserved<MeUserRow[]>`
        SELECT id, email, name, role, tenant_id, active
        FROM public.users
        WHERE id = ${uid}
        LIMIT 1
      `,
      { connectionWaitMs, queryMs: 0 },
    );
    const queryMs = Date.now() - tQuery0;

    console.log("[ME_STEP_USER_QUERY_END]", {
      requestId,
      connectionWaitMs,
      queryMs,
      rowCount: rows.length,
      ...getDatabaseRuntimeDiag(),
    });

    return { rows, connectionWaitMs, queryMs };
  } catch (err) {
    if (isAuthContextTimeout(err)) {
      console.error("[ME_STEP_USER_QUERY_TIMEOUT]", {
        requestId,
        step: err.step,
        connectionWaitMs: err.connectionWaitMs ?? connectionWaitMs,
        queryMs: err.queryMs,
        elapsedMs: Date.now() - tConn0,
        ...getDatabaseRuntimeDiag(),
      });
    }
    throw err;
  } finally {
    if (reserved) {
      try {
        reserved.release();
      } catch (releaseErr) {
        console.warn(
          "[ME_STEP_USER_QUERY_RELEASE_WARN]",
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        );
      }
    }
  }
}

/**
 * Mede espera de conexão (probe reserve/release) e depois executa o trabalho
 * de empresa com timeout próprio — sem alterar o SQL interno.
 */
export async function meCompanyStepWithConnectionTiming<T>(
  requestId: string,
  work: () => Promise<T>,
): Promise<{ result: T; connectionWaitMs: number; queryMs: number }> {
  console.log("[ME_STEP_COMPANY_START]", {
    requestId,
    ...getDatabaseRuntimeDiag(),
  });

  const tConn0 = Date.now();
  let connectionWaitMs = 0;
  const reservePromise = reserveSqlConnection();

  try {
    let probe: Awaited<ReturnType<typeof reserveSqlConnection>>;
    try {
      probe = await withMeDbTimeout("company_connection", reservePromise, {
        connectionWaitMs: 0,
        queryMs: null,
      });
    } catch (err) {
      releaseReserveWhenReady(reservePromise);
      throw err;
    }
    connectionWaitMs = Date.now() - tConn0;
    try {
      probe.release();
    } catch (releaseErr) {
      console.warn(
        "[ME_STEP_COMPANY_PROBE_RELEASE_WARN]",
        releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      );
    }

    const tQuery0 = Date.now();
    const result = await withMeDbTimeout("company_query", work(), {
      connectionWaitMs,
      queryMs: 0,
    });
    const queryMs = Date.now() - tQuery0;

    console.log("[ME_STEP_COMPANY_END]", {
      requestId,
      connectionWaitMs,
      queryMs,
      ...getDatabaseRuntimeDiag(),
    });

    return { result, connectionWaitMs, queryMs };
  } catch (err) {
    if (isAuthContextTimeout(err)) {
      console.error("[ME_STEP_COMPANY_TIMEOUT]", {
        requestId,
        step: err.step,
        connectionWaitMs: err.connectionWaitMs ?? connectionWaitMs,
        queryMs: err.queryMs,
        elapsedMs: Date.now() - tConn0,
        ...getDatabaseRuntimeDiag(),
      });
    }
    throw err;
  }
}
