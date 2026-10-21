/**
 * Orçamento de memória da ingestão de webhooks.
 *
 * O corpo precisa ser lido inteiro para ser persistido, e a Evolution manda
 * mídia em base64 — um documento de 100 MB vira ~134 MB de JSON. Limitar o
 * tamanho resolveria a memória mas rejeitaria arquivo válido, o que não é
 * aceitável. A saída é limitar quantos bytes existem em memória ao mesmo
 * tempo: cada requisição reserva o que vai ler antes de começar.
 *
 * Requisição que não consegue reserva a tempo recebe 503 com Retry-After —
 * o provedor reenvia. Nada é descartado em silêncio.
 */

export class WebhookInboxBudgetTimeoutError extends Error {
  readonly code = "inbox_memory_budget_timeout" as const;
  readonly waitedMs: number;
  readonly requestedBytes: number;

  constructor(requestedBytes: number, waitedMs: number) {
    super("inbox_memory_budget_timeout");
    this.name = "WebhookInboxBudgetTimeoutError";
    this.requestedBytes = requestedBytes;
    this.waitedMs = waitedMs;
  }
}

export function isWebhookInboxBudgetTimeout(
  error: unknown,
): error is WebhookInboxBudgetTimeoutError {
  return (
    error instanceof WebhookInboxBudgetTimeoutError ||
    (error instanceof Error && error.message === "inbox_memory_budget_timeout")
  );
}

export type ByteBudgetRelease = () => void;

export type ByteBudget = {
  totalBytes: number;
  acquire: (bytes: number, timeoutMs: number) => Promise<ByteBudgetRelease>;
  metrics: () => { totalBytes: number; availableBytes: number; waiting: number };
};

type BudgetWaiter = {
  bytes: number;
  resolve: (release: ByteBudgetRelease) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createByteBudget(totalBytes: number): ByteBudget {
  const total = Math.max(1, Math.floor(totalBytes));
  let available = total;
  let waiters: BudgetWaiter[] = [];

  function makeRelease(bytes: number): ByteBudgetRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      available = Math.min(total, available + bytes);
      drain();
    };
  }

  // FIFO estrito: uma requisição gigante não é ultrapassada indefinidamente
  // por requisições pequenas.
  function drain(): void {
    while (waiters.length > 0 && waiters[0].bytes <= available) {
      const waiter = waiters.shift()!;
      clearTimeout(waiter.timer);
      available -= waiter.bytes;
      waiter.resolve(makeRelease(waiter.bytes));
    }
  }

  return {
    totalBytes: total,
    metrics: () => ({ totalBytes: total, availableBytes: available, waiting: waiters.length }),
    acquire(bytes: number, timeoutMs: number): Promise<ByteBudgetRelease> {
      // Nunca reserva mais que o orçamento inteiro: um payload maior que o
      // total é admitido sozinho, em vez de travar para sempre.
      const need = Math.min(total, Math.max(1, Math.floor(bytes)));

      if (waiters.length === 0 && need <= available) {
        available -= need;
        return Promise.resolve(makeRelease(need));
      }

      const startedAt = Date.now();
      return new Promise<ByteBudgetRelease>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w.timer !== timer);
          reject(new WebhookInboxBudgetTimeoutError(need, Date.now() - startedAt));
        }, Math.max(1, timeoutMs));

        waiters.push({ bytes: need, resolve, reject, timer });
      });
    },
  };
}
