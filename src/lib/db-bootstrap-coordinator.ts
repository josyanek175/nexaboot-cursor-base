/**
 * Coordenação do bootstrap de schema (estado + watchdog).
 * Separado para testes sem Postgres. Sem SQL de negócio.
 *
 * Invariantes:
 * - activeRun=true do início do run até o finally real (DDL/reserve terminou).
 * - Watchdog rejeita apenas waiters (503); NÃO inicia outro bootstrap.
 * - Novo bootstrap só quando activeRun=false.
 */
import { randomUUID } from "node:crypto";

export type DatabaseBootstrapState = "idle" | "running" | "ready" | "failed";

export type BootstrapStepLog = {
  processPid: number;
  instanceId: string;
  attempt: number;
  step: string;
  durationMs: number;
};

export type BootstrapCoordinatorOptions = {
  cooldownMs: number;
  watchdogMs: number;
  instanceId?: string;
  processPid?: number;
  /** Executa o trabalho real (reserve + DDL). */
  run: (ctx: BootstrapRunContext) => Promise<void>;
  now?: () => number;
  log?: (event: string, payload: Record<string, unknown>) => void;
};

export type BootstrapRunContext = {
  attempt: number;
  runId: number;
  instanceId: string;
  processPid: number;
  /** true só se reset()/cancelamento explícito — NÃO pelo watchdog de waiters. */
  signal: { readonly aborted: boolean };
  logStep: (
    phase: "START" | "OK" | "ERROR" | "TIMEOUT",
    step: string,
    durationMs: number,
    extra?: Record<string, unknown>,
  ) => void;
};

export type BootstrapCoordinator = {
  bootstrap: () => Promise<void>;
  getState: () => DatabaseBootstrapState;
  getAttempt: () => number;
  getInstanceId: () => string;
  getCooldownUntil: () => number;
  /** true enquanto o run (DDL/reserve) ainda não chegou ao finally. */
  isActiveRun: () => boolean;
  /** true se o watchdog já abandonou os waiters deste run. */
  areWaitersAbandoned: () => boolean;
  reset: () => void;
};

export function createBootstrapCoordinator(
  opts: BootstrapCoordinatorOptions,
): BootstrapCoordinator {
  const now = opts.now ?? Date.now;
  const log =
    opts.log ??
    ((event, payload) => {
      console.log(`[${event}]`, payload);
    });
  const instanceId = opts.instanceId ?? randomUUID();
  const processPid = opts.processPid ?? process.pid;

  let state: DatabaseBootstrapState = "idle";
  /** Execução real ainda em andamento (independente dos waiters HTTP). */
  let activeRun = false;
  /** Promise compartilhada pelos waiters atuais (antes do abandono). */
  let sharedWaiter: Promise<void> | null = null;
  let waiterSettled = false;
  let waitersAbandoned = false;
  let resolveWaiter: (() => void) | null = null;
  let rejectWaiter: ((err: Error) => void) | null = null;
  let attempt = 0;
  let runId = 0;
  let cooldownUntil = 0;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cancelamento explícito (reset de teste) — não usado pelo watchdog. */
  let cancelRunFlag = false;

  function clearWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function settleWaiterResolve() {
    if (waiterSettled) return;
    waiterSettled = true;
    clearWatchdog();
    resolveWaiter?.();
  }

  function settleWaiterReject(err: Error) {
    if (waiterSettled) return;
    waiterSettled = true;
    clearWatchdog();
    rejectWaiter?.(err);
  }

  /**
   * Watchdog: só abandona waiters (503). Mantém activeRun até o finally do run.
   * NÃO incrementa runId e NÃO cancela o DDL em andamento.
   */
  function abandonWaiters(reason: string) {
    if (!activeRun || waiterSettled) return;
    const currentAttempt = attempt;
    log("DB_BOOTSTRAP_TIMEOUT", {
      processPid,
      instanceId,
      attempt: currentAttempt,
      step: "watchdog",
      durationMs: opts.watchdogMs,
      reason,
      activeRun: true,
    });
    waitersAbandoned = true;
    // "failed" = não pronto para tráfego; activeRun continua true.
    state = "failed";
    settleWaiterReject(new Error("database_initialization_unavailable"));
  }

  function bootstrap(): Promise<void> {
    // Sucesso estável: reutiliza Promise resolvida.
    if (state === "ready" && sharedWaiter && !activeRun) {
      return sharedWaiter;
    }

    // Run ainda executando (possível DDL ativo no PG).
    if (activeRun) {
      // Antes do watchdog: compartilha a mesma espera.
      if (!waiterSettled && sharedWaiter) {
        return sharedWaiter;
      }
      // Waiters já abandonados (ou settled): 503, sem novo bootstrap.
      return Promise.reject(new Error("database_initialization_unavailable"));
    }

    // Run anterior terminou em falha: cooldown sem overlap de DDL.
    if (state === "failed" && now() < cooldownUntil) {
      return Promise.reject(new Error("database_initialization_unavailable"));
    }

    const myAttempt = ++attempt;
    const myRunId = ++runId;
    cancelRunFlag = false;
    waiterSettled = false;
    waitersAbandoned = false;
    activeRun = true;
    state = "running";

    sharedWaiter = new Promise<void>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    // Evita unhandledRejection se ninguém await imediatamente.
    sharedWaiter.catch(() => {});

    log("DB_BOOTSTRAP_START", {
      processPid,
      instanceId,
      attempt: myAttempt,
      step: "bootstrap",
      durationMs: 0,
      state,
    });

    watchdogTimer = setTimeout(() => {
      if (runId !== myRunId || !activeRun) return;
      abandonWaiters("watchdog_30s");
    }, opts.watchdogMs);

    const signal = {
      get aborted() {
        return cancelRunFlag;
      },
    };

    const logStep: BootstrapRunContext["logStep"] = (
      phase,
      step,
      durationMs,
      extra,
    ) => {
      log(`DB_BOOTSTRAP_STEP_${phase}`, {
        processPid,
        instanceId,
        attempt: myAttempt,
        step,
        durationMs,
        ...extra,
      });
    };

    void (async () => {
      const t0 = now();
      try {
        await opts.run({
          attempt: myAttempt,
          runId: myRunId,
          instanceId,
          processPid,
          signal,
          logStep,
        });
        if (cancelRunFlag) return;

        state = "ready";
        log("DB_BOOTSTRAP_OK", {
          processPid,
          instanceId,
          attempt: myAttempt,
          step: "bootstrap",
          durationMs: now() - t0,
          waitersAbandoned,
        });

        if (!waiterSettled) {
          settleWaiterResolve();
        } else {
          // Waiters já receberam 503; próximas chamadas reutilizam sucesso.
          sharedWaiter = Promise.resolve();
        }
      } catch (e) {
        if (cancelRunFlag) return;
        const message = e instanceof Error ? e.message : String(e);
        state = "failed";
        cooldownUntil = now() + opts.cooldownMs;
        log("DB_BOOTSTRAP_ERROR", {
          processPid,
          instanceId,
          attempt: myAttempt,
          step: "bootstrap",
          durationMs: now() - t0,
          message,
          waitersAbandoned,
        });

        if (!waiterSettled) {
          settleWaiterReject(new Error("database_initialization_unavailable"));
        }
        // sharedWaiter rejeitada ou já abandonada; limpa para próximo ciclo após cooldown.
        if (waiterSettled && waitersAbandoned) {
          sharedWaiter = null;
        } else if (waiterSettled) {
          sharedWaiter = null;
        }
      } finally {
        clearWatchdog();
        // Só aqui um novo bootstrap pode começar.
        activeRun = false;
      }
    })();

    return sharedWaiter;
  }

  return {
    bootstrap,
    getState: () => state,
    getAttempt: () => attempt,
    getInstanceId: () => instanceId,
    getCooldownUntil: () => cooldownUntil,
    isActiveRun: () => activeRun,
    areWaitersAbandoned: () => waitersAbandoned,
    reset() {
      clearWatchdog();
      cancelRunFlag = true;
      runId += 1;
      activeRun = false;
      waitersAbandoned = false;
      waiterSettled = false;
      state = "idle";
      sharedWaiter = null;
      attempt = 0;
      cooldownUntil = 0;
      resolveWaiter = null;
      rejectWaiter = null;
      cancelRunFlag = false;
    },
  };
}
