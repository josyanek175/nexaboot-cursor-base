/**
 * Diagnóstico de GET /api/auth/me — queries no pool normal (sem reserve).
 * Timeout real via PostgreSQL SET LOCAL statement_timeout (postgres.js 3.4.9).
 * Aquisição de slot via gate (não Promise.race sobre begin — evita conexão zumbi).
 */
import { sql, getDatabaseRuntimeDiag } from "@/lib/pg.server";
import { setPoolDiagRequestId } from "@/lib/pg-pool-diag.server";
import {
  withPoolGateSlot,
  isPoolAcquireTimeout,
  logPoolGateStatus,
} from "@/lib/pg-pool-gate.server";
import { getCurrentUserCompanyInfo } from "@/lib/company.server";

export const ME_DB_STEP_TIMEOUT_MS = 5_000;
/** Espera máxima por slot do gate antes de 503 (não deixa Pending eterno). */
export const ME_POOL_ACQUIRE_TIMEOUT_MS = 3_000;

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
  return Response.json(
    { error: "auth_context_timeout", retryable: true },
    { status: 503, headers: { "Retry-After": "2" } },
  );
}

/** PostgreSQL cancelou a statement (código 57014). */
export function isPgStatementTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string };
  if (e.code === "57014") return true;
  const msg = String(e.message ?? "").toLowerCase();
  return msg.includes("statement timeout") || msg.includes("canceling statement");
}

/**
 * Executa fn numa transação curta com statement_timeout local.
 * Cancela a query no servidor — não abandona Promise.race com conexão presa.
 */
export async function withMeStatementTimeout<T>(
  fn: (tx: ReturnType<typeof sql>) => Promise<T>,
): Promise<T> {
  const s = sql();
  return s.begin(async (tx) => {
    // Inteiro = milissegundos (documentação PostgreSQL / connection parameter).
    await tx.unsafe(`SET LOCAL statement_timeout = ${ME_DB_STEP_TIMEOUT_MS}`);
    return fn(tx as unknown as ReturnType<typeof sql>);
  }) as Promise<T>;
}

/**
 * Gate + statement_timeout. Libera slot sempre em finally (via withPoolGateSlot).
 */
export async function withMeDbStep<T>(
  origin: string,
  fn: (tx: ReturnType<typeof sql>) => Promise<T>,
): Promise<{ result: T; connectionWaitMs: number }> {
  const waitT0 = Date.now();
  let acquiredAt = 0;
  try {
    const result = await withPoolGateSlot(origin, ME_POOL_ACQUIRE_TIMEOUT_MS, async () => {
      acquiredAt = Date.now();
      return withMeStatementTimeout(fn);
    });
    return { result, connectionWaitMs: Math.max(0, acquiredAt - waitT0) };
  } catch (e) {
    if (isPoolAcquireTimeout(e)) {
      logPoolGateStatus("PG_POOL_STATUS_ME_ACQUIRE_TIMEOUT");
      throw new AuthContextTimeoutError(`${origin}_pool_wait`, {
        connectionWaitMs: e.waitedMs,
        queryMs: null,
      });
    }
    throw e;
  }
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
 * SELECT do usuário via pool normal (sem reserve / sem Promise.race sobre begin).
 */
export async function meUserQueryWithConnectionTiming(
  uid: string,
  requestId: string,
): Promise<{
  rows: MeUserRow[];
  connectionWaitMs: number | null;
  queryMs: number;
}> {
  console.log("[ME_STEP_USER_QUERY_START]", {
    requestId,
    ...getDatabaseRuntimeDiag(),
  });

  setPoolDiagRequestId(requestId);
  const t0 = Date.now();

  try {
    const { result: rows, connectionWaitMs } = await withMeDbStep(
      "auth_me_user",
      async (tx) => {
        return tx<MeUserRow[]>`
          SELECT id, email, name, role, tenant_id, active
          FROM public.users
          WHERE id = ${uid}
          LIMIT 1
        `;
      },
    );
    const queryMs = Date.now() - t0;

    console.log("[ME_STEP_USER_QUERY_OK]", {
      requestId,
      connectionWaitMs,
      queryMs,
      rowCount: rows.length,
      ...getDatabaseRuntimeDiag(),
    });

    return { rows, connectionWaitMs, queryMs };
  } catch (err) {
    const queryMs = Date.now() - t0;
    console.error("[ME_STEP_USER_QUERY_ERROR]", {
      requestId,
      queryMs,
      isTimeout: isPgStatementTimeout(err) || isAuthContextTimeout(err),
      message: err instanceof Error ? err.message : String(err),
      ...getDatabaseRuntimeDiag(),
    });
    if (isAuthContextTimeout(err)) throw err;
    if (isPgStatementTimeout(err)) {
      throw new AuthContextTimeoutError("user_query", {
        connectionWaitMs: null,
        queryMs,
      });
    }
    throw err;
  } finally {
    setPoolDiagRequestId(null);
  }
}

/**
 * Empresa via pool normal, sem probe reserve.
 * Mesmo statement_timeout na mesma sessão da TX.
 */
export async function meCompanyStepWithConnectionTiming(
  requestId: string,
  uid: string,
): Promise<{
  result: Awaited<ReturnType<typeof getCurrentUserCompanyInfo>>;
  connectionWaitMs: number | null;
  queryMs: number;
}> {
  console.log("[ME_STEP_COMPANY_QUERY_START]", {
    requestId,
    ...getDatabaseRuntimeDiag(),
  });

  setPoolDiagRequestId(requestId);
  const t0 = Date.now();

  try {
    const { result, connectionWaitMs } = await withMeDbStep(
      "auth_me_company",
      async (tx) => {
        return getCurrentUserCompanyInfo(uid, undefined, tx);
      },
    );
    const queryMs = Date.now() - t0;

    console.log("[ME_STEP_COMPANY_QUERY_OK]", {
      requestId,
      connectionWaitMs,
      queryMs,
      companyValid: result.companyValid,
      ...getDatabaseRuntimeDiag(),
    });

    return { result, connectionWaitMs, queryMs };
  } catch (err) {
    const queryMs = Date.now() - t0;
    console.error("[ME_STEP_COMPANY_QUERY_ERROR]", {
      requestId,
      queryMs,
      isTimeout: isPgStatementTimeout(err) || isAuthContextTimeout(err),
      message: err instanceof Error ? err.message : String(err),
      ...getDatabaseRuntimeDiag(),
    });
    if (isAuthContextTimeout(err)) throw err;
    if (isPgStatementTimeout(err)) {
      throw new AuthContextTimeoutError("company_query", {
        connectionWaitMs: null,
        queryMs,
      });
    }
    throw err;
  } finally {
    setPoolDiagRequestId(null);
  }
}
