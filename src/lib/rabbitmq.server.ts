/**
 * Camada de conexão com o RabbitMQ.
 *
 * Isolada de propósito: nada em `src/routes` importa este módulo, então o
 * endpoint HTTP não depende do broker nem o build precisa resolver `amqplib`.
 * O driver é carregado por import dinâmico, e os testes injetam um `connect`
 * falso — nenhum teste desta etapa exige broker de verdade.
 *
 * A URL do broker nunca é registrada em log, nem inteira nem parcial.
 */

import {
  RABBITMQ_DEFAULT_EXCHANGE,
  readWebhookOutboxExchange,
} from "@/lib/webhook-outbox-core";

export { RABBITMQ_DEFAULT_EXCHANGE };

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return floored > 0 ? floored : fallback;
}

function parseBoolean(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export const RABBITMQ_DEFAULT_QUEUE = "nexaboot.dev.webhook.queue";
export const RABBITMQ_DEFAULT_DLQ = "nexaboot.dev.webhook.dlq";
export const RABBITMQ_DEFAULT_PREFETCH = 10;
export const RABBITMQ_DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const RABBITMQ_DEFAULT_RECONNECT_MIN_MS = 1_000;
export const RABBITMQ_DEFAULT_RECONNECT_MAX_MS = 30_000;

export type RabbitConfig = {
  enabled: boolean;
  url: string | null;
  exchange: string;
  queue: string;
  dlq: string;
  prefetch: number;
  connectTimeoutMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
};

export function readRabbitConfig(env: NodeJS.ProcessEnv = process.env): RabbitConfig {
  const reconnectMinMs = parsePositiveInt(
    env.RABBITMQ_RECONNECT_MIN_MS,
    RABBITMQ_DEFAULT_RECONNECT_MIN_MS,
  );
  const reconnectMaxMs = parsePositiveInt(
    env.RABBITMQ_RECONNECT_MAX_MS,
    RABBITMQ_DEFAULT_RECONNECT_MAX_MS,
  );

  return {
    // Default false: sem configuração explícita, nada é publicado.
    enabled: parseBoolean(env.RABBITMQ_ENABLED),
    url: env.RABBITMQ_URL?.trim() || null,
    exchange: readWebhookOutboxExchange(env),
    queue: env.RABBITMQ_WEBHOOK_QUEUE?.trim() || RABBITMQ_DEFAULT_QUEUE,
    dlq: env.RABBITMQ_WEBHOOK_DLQ?.trim() || RABBITMQ_DEFAULT_DLQ,
    prefetch: parsePositiveInt(env.RABBITMQ_PREFETCH, RABBITMQ_DEFAULT_PREFETCH),
    connectTimeoutMs: parsePositiveInt(
      env.RABBITMQ_CONNECT_TIMEOUT_MS,
      RABBITMQ_DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    reconnectMinMs,
    reconnectMaxMs: Math.max(reconnectMinMs, reconnectMaxMs),
  };
}

/**
 * Falha cedo e com mensagem clara em configuração que só quebraria na primeira
 * publicação — ou pior, que publicaria no lugar errado.
 */
export function assertRabbitConfig(config: RabbitConfig): void {
  if (!config.enabled) return;
  if (!config.url) {
    throw new Error("RABBITMQ_ENABLED=true exige RABBITMQ_URL configurada");
  }
  for (const [name, value] of [
    ["RABBITMQ_EXCHANGE", config.exchange],
    ["RABBITMQ_WEBHOOK_QUEUE", config.queue],
    ["RABBITMQ_WEBHOOK_DLQ", config.dlq],
  ] as const) {
    if (!value.trim()) throw new Error(`${name} não pode ser vazio`);
  }
  // Fila e DLQ iguais transformariam o dead letter em laço infinito.
  if (config.queue === config.dlq) {
    throw new Error("RABBITMQ_WEBHOOK_QUEUE e RABBITMQ_WEBHOOK_DLQ devem ser diferentes");
  }
  if (config.exchange === config.queue || config.exchange === config.dlq) {
    throw new Error("RABBITMQ_EXCHANGE deve ser diferente dos nomes de fila");
  }
}

/**
 * Nomes de DEV e de produção precisam ser distintos: publicar DEV numa fila de
 * produção entrega mensagem de teste a cliente real.
 */
export function describeRabbitTopology(config: RabbitConfig) {
  return { exchange: config.exchange, queue: config.queue, dlq: config.dlq };
}

// ---------------------------------------------------------------------------
// Abstração mínima do driver (o suficiente para publicar com confirm)
// ---------------------------------------------------------------------------

export type RabbitPublishOptions = {
  persistent?: boolean;
  contentType?: string;
  messageId?: string;
  timestamp?: number;
};

export type RabbitChannelLike = {
  assertExchange: (name: string, type: string, options: Record<string, unknown>) => Promise<unknown>;
  assertQueue: (name: string, options: Record<string, unknown>) => Promise<unknown>;
  bindQueue: (queue: string, exchange: string, pattern: string) => Promise<unknown>;
  prefetch?: (count: number) => unknown;
  publish: (
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: RabbitPublishOptions,
    callback: (err: unknown) => void,
  ) => unknown;
  close?: () => Promise<unknown>;
  on?: (event: string, handler: (arg?: unknown) => void) => unknown;
};

export type RabbitConnectionLike = {
  createConfirmChannel: () => Promise<RabbitChannelLike>;
  close?: () => Promise<unknown>;
  on?: (event: string, handler: (arg?: unknown) => void) => unknown;
};

export type RabbitConnect = (
  url: string,
  options: { timeout: number },
) => Promise<RabbitConnectionLike>;

export class RabbitUnavailableError extends Error {
  readonly code = "rabbitmq_unavailable" as const;
  readonly reason: string;
  readonly retryInMs: number;

  constructor(reason: string, retryInMs: number, cause?: unknown) {
    super(`rabbitmq_unavailable:${reason}`);
    this.name = "RabbitUnavailableError";
    this.reason = reason;
    this.retryInMs = retryInMs;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export function isRabbitUnavailable(error: unknown): error is RabbitUnavailableError {
  return error instanceof RabbitUnavailableError;
}

/** Remove credenciais de qualquer mensagem antes de virar log. */
export function maskRabbitError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/amqps?:\/\/[^\s'"]+/gi, "amqp://[redacted]")
    .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "postgres://[redacted]")
    .replace(/(password|passwd|pwd)[=:]\s*[^\s,;'"]+/gi, "$1=[redacted]")
    .slice(0, 300);
}

async function defaultConnect(
  url: string,
  options: { timeout: number },
): Promise<RabbitConnectionLike> {
  // Import indireto: mantém `amqplib` fora do grafo estático do bundler, então
  // o build do web não precisa do pacote instalado.
  const specifier = "amqplib";
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    default?: { connect: RabbitConnect };
    connect?: RabbitConnect;
  };
  const amqp = mod.default ?? (mod as { connect: RabbitConnect });
  return amqp.connect(url, { timeout: options.timeout });
}

// ---------------------------------------------------------------------------
// Publicador
// ---------------------------------------------------------------------------

export type RabbitPublishRequest = {
  routingKey: string;
  body: unknown;
  exchange?: string;
  messageId?: string;
};

export type RabbitPublisher = {
  /** Resolve SOMENTE depois do publisher confirm do broker. */
  publish: (request: RabbitPublishRequest) => Promise<void>;
  close: () => Promise<void>;
  isConnected: () => boolean;
  getState: () => {
    connected: boolean;
    consecutiveFailures: number;
    nextAttemptInMs: number;
  };
};

type LogFn = (tag: string, data: Record<string, unknown>) => void;

export function createRabbitPublisher(options: {
  config: RabbitConfig;
  connect?: RabbitConnect;
  log?: LogFn;
  logError?: LogFn;
  now?: () => number;
  random?: () => number;
}): RabbitPublisher {
  const config = options.config;
  const connect = options.connect ?? defaultConnect;
  const log = options.log ?? ((tag, data) => console.log(`[${tag}]`, data));
  const logError = options.logError ?? ((tag, data) => console.error(`[${tag}]`, data));
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;

  let connection: RabbitConnectionLike | null = null;
  let channel: RabbitChannelLike | null = null;
  let connecting: Promise<RabbitChannelLike> | null = null;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0;
  let closed = false;

  function backoffDelayMs(attempt: number): number {
    const exponent = Math.min(Math.max(0, attempt - 1), 20);
    const ceiling = Math.min(config.reconnectMaxMs, config.reconnectMinMs * 2 ** exponent);
    const jittered = Math.round(ceiling * random());
    return Math.min(config.reconnectMaxMs, Math.max(config.reconnectMinMs, jittered));
  }

  function dropConnection(reason: string, error?: unknown): void {
    const wasConnected = channel != null;
    channel = null;
    connection = null;
    if (wasConnected) {
      log("RABBITMQ_DISCONNECTED", {
        reason,
        ...(error !== undefined ? { error: maskRabbitError(error) } : {}),
      });
    }
  }

  async function openChannel(): Promise<RabbitChannelLike> {
    if (!config.url) {
      throw new RabbitUnavailableError("missing_url", config.reconnectMaxMs);
    }

    try {
      const conn = await connect(config.url, { timeout: config.connectTimeoutMs });
      conn.on?.("close", () => dropConnection("connection_close"));
      conn.on?.("error", (e) => dropConnection("connection_error", e));

      const ch = await conn.createConfirmChannel();
      await ch.assertExchange(config.exchange, "topic", { durable: true });
      // DLQ primeiro: a fila principal referencia a DLQ na criação.
      await ch.assertQueue(config.dlq, { durable: true });
      await ch.assertQueue(config.queue, {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": config.dlq,
        },
      });
      await ch.bindQueue(config.queue, config.exchange, "#");
      await ch.prefetch?.(config.prefetch);
      ch.on?.("close", () => dropConnection("channel_close"));
      ch.on?.("error", (e) => dropConnection("channel_error", e));

      connection = conn;
      channel = ch;
      consecutiveFailures = 0;
      nextAttemptAt = 0;
      log("RABBITMQ_CONNECTED", {
        ...describeRabbitTopology(config),
        prefetch: config.prefetch,
        // a URL nunca é registrada
        hasUrl: true,
      });
      return ch;
    } catch (e) {
      consecutiveFailures += 1;
      const delayMs = backoffDelayMs(consecutiveFailures);
      nextAttemptAt = now() + delayMs;
      channel = null;
      connection = null;
      logError("RABBITMQ_RECONNECT_SCHEDULED", {
        attempt: consecutiveFailures,
        delayMs,
        error: maskRabbitError(e),
      });
      throw new RabbitUnavailableError("connect_failed", delayMs, e);
    }
  }

  async function ensureChannel(): Promise<RabbitChannelLike> {
    if (closed) throw new RabbitUnavailableError("publisher_closed", 0);
    if (channel) return channel;
    if (connecting) return connecting;

    // Backoff sob demanda: enquanto o prazo não vence, a publicação falha
    // rápido em vez de martelar o broker a cada mensagem da fila.
    const remaining = nextAttemptAt - now();
    if (remaining > 0) throw new RabbitUnavailableError("reconnect_backoff", remaining);

    connecting = openChannel();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  return {
    isConnected: () => channel != null,
    getState: () => ({
      connected: channel != null,
      consecutiveFailures,
      nextAttemptInMs: Math.max(0, nextAttemptAt - now()),
    }),

    async publish(request: RabbitPublishRequest): Promise<void> {
      const ch = await ensureChannel();
      const content = Buffer.from(JSON.stringify(request.body), "utf8");

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (error) {
            dropConnection("publish_nack", error);
            reject(error instanceof Error ? error : new Error(maskRabbitError(error)));
            return;
          }
          resolve();
        };

        try {
          ch.publish(
            request.exchange ?? config.exchange,
            request.routingKey,
            content,
            {
              persistent: true,
              contentType: "application/json",
              messageId: request.messageId,
              timestamp: Math.floor(now() / 1000),
            },
            (err) => settle(err ?? undefined),
          );
        } catch (e) {
          settle(e);
        }
      });
    },

    async close(): Promise<void> {
      closed = true;
      const ch = channel;
      const conn = connection;
      channel = null;
      connection = null;
      try {
        await ch?.close?.();
      } catch {
        // fechamento é best-effort; o processo está encerrando
      }
      try {
        await conn?.close?.();
      } catch {
        // idem
      }
    },
  };
}
