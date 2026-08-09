/**
 * Consumidor RabbitMQ do message-worker.
 *
 * Espelha o publicador: conexão reutilizada, topologia declarada na abertura,
 * reconexão com backoff e nenhum credencial em log. A diferença é o ACK
 * manual — o worker só confirma depois que o COMMIT no PostgreSQL aconteceu.
 *
 * Backoff de processamento NÃO prende prefetch: o worker grava `retry` +
 * `available_at` e dá ACK; um republisher republica quando o prazo vence.
 * `requeue` imediato só existe para falhas antes de persistir estado.
 */

import {
  assertRabbitConfig,
  describeRabbitTopology,
  maskRabbitError,
  RabbitUnavailableError,
  type RabbitChannelLike,
  type RabbitConfig,
  type RabbitConnect,
  type RabbitConnectionLike,
  type RabbitConsumedMessage,
} from "@/lib/rabbitmq.server";

type LogFn = (tag: string, data: Record<string, unknown>) => void;

async function defaultConnect(
  url: string,
  options: { timeout: number },
): Promise<RabbitConnectionLike> {
  const specifier = "amqplib";
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    default?: { connect: RabbitConnect };
    connect?: RabbitConnect;
  };
  const amqp = mod.default ?? (mod as { connect: RabbitConnect });
  return amqp.connect(url, { timeout: options.timeout });
}

export type RabbitConsumerHandler = (msg: {
  content: Buffer;
  deliveryTag: number;
  redelivered: boolean;
  routingKey: string | null;
  messageId: string | null;
}) => Promise<{ action: "ack" | "requeue"; delayMs?: number }>;

export type RabbitConsumer = {
  /** Inicia o consumo. Resolve quando a conexão está aberta e o consumer ligado. */
  start: (handler: RabbitConsumerHandler) => Promise<void>;
  /** Para de receber novas mensagens e espera as em voo terminarem. */
  stop: (options?: { drainTimeoutMs?: number }) => Promise<void>;
  close: () => Promise<void>;
  isConnected: () => boolean;
  isActive: () => boolean;
  getState: () => {
    connected: boolean;
    active: boolean;
    inFlight: number;
    consecutiveFailures: number;
    nextAttemptInMs: number;
  };
};

/**
 * Cria o consumidor. A topologia (exchange, fila, DLQ) é a mesma do
 * publicador: se a fila ainda não existir, o consumer a cria.
 */
export function createRabbitConsumer(options: {
  config: RabbitConfig;
  /** Prefetch efetivo — o message-worker usa WEBHOOK_MESSAGE_PREFETCH. */
  prefetch: number;
  connect?: RabbitConnect;
  sleep?: (ms: number) => Promise<void>;
  log?: LogFn;
  logError?: LogFn;
  now?: () => number;
  random?: () => number;
}): RabbitConsumer {
  const config = options.config;
  assertRabbitConfig(config);

  const connect = options.connect ?? defaultConnect;
  const log = options.log ?? ((tag, data) => console.log(`[${tag}]`, data));
  const logError = options.logError ?? ((tag, data) => console.error(`[${tag}]`, data));
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let connection: RabbitConnectionLike | null = null;
  let channel: RabbitChannelLike | null = null;
  let consumerTag: string | null = null;
  let connecting: Promise<RabbitChannelLike> | null = null;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0;
  let closed = false;
  let active = false;
  let handler: RabbitConsumerHandler | null = null;
  let inFlight = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    consumerTag = null;
    if (wasConnected) {
      log("RABBITMQ_DISCONNECTED", {
        reason,
        ...(error !== undefined ? { error: maskRabbitError(error) } : {}),
      });
    }
    if (active && !closed) scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (reconnectTimer || closed || !active) return;
    consecutiveFailures += 1;
    const delayMs = backoffDelayMs(consecutiveFailures);
    nextAttemptAt = now() + delayMs;
    logError("RABBITMQ_RECONNECT_SCHEDULED", {
      attempt: consecutiveFailures,
      delayMs,
      role: "consumer",
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void ensureConsuming().catch(() => undefined);
    }, delayMs);
  }

  async function openChannel(): Promise<RabbitChannelLike> {
    if (!config.url) {
      throw new RabbitUnavailableError("missing_url", config.reconnectMaxMs);
    }

    try {
      const conn = await connect(config.url, { timeout: config.connectTimeoutMs });
      conn.on?.("close", () => dropConnection("connection_close"));
      conn.on?.("error", (e) => dropConnection("connection_error", e));

      // Confirm channel: o consumer usa ack/nack; o caminho normal é ACK após
      // estado durável no PostgreSQL (incluindo retry).
      const ch = await (conn.createChannel?.() ?? conn.createConfirmChannel());
      await ch.assertExchange(config.exchange, "topic", { durable: true });
      await ch.assertQueue(config.dlq, { durable: true });
      await ch.assertQueue(config.queue, {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": config.dlq,
        },
      });
      await ch.bindQueue(config.queue, config.exchange, "#");
      await ch.prefetch?.(options.prefetch);
      ch.on?.("close", () => dropConnection("channel_close"));
      ch.on?.("error", (e) => dropConnection("channel_error", e));

      connection = conn;
      channel = ch;
      consecutiveFailures = 0;
      nextAttemptAt = 0;
      log("RABBITMQ_CONNECTED", {
        ...describeRabbitTopology(config),
        prefetch: options.prefetch,
        role: "consumer",
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
        role: "consumer",
        error: maskRabbitError(e),
      });
      throw new RabbitUnavailableError("connect_failed", delayMs, e);
    }
  }

  async function ensureChannel(): Promise<RabbitChannelLike> {
    if (closed) throw new RabbitUnavailableError("consumer_closed", 0);
    if (channel) return channel;
    if (connecting) return connecting;
    connecting = openChannel();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  async function ackMessage(msg: RabbitConsumedMessage): Promise<void> {
    try {
      channel?.ack?.(msg);
    } catch (e) {
      logError("WEBHOOK_MESSAGE_ACK", {
        reason: "ack_failed",
        error: maskRabbitError(e),
      });
    }
  }

  async function nackRequeue(msg: RabbitConsumedMessage): Promise<void> {
    try {
      channel?.nack?.(msg, false, true);
    } catch (e) {
      logError("WEBHOOK_MESSAGE_NACK", {
        reason: "nack_failed",
        error: maskRabbitError(e),
      });
    }
  }

  /**
   * Requeue imediato (sem sleep). O backoff durável vive no PostgreSQL; este
   * caminho só existe para falhas antes de persistir estado. Segurar prefetch
   * durante backoff foi removido de propósito.
   */
  async function requeueNow(msg: RabbitConsumedMessage): Promise<void> {
    await nackRequeue(msg);
  }

  async function handleDelivery(msg: RabbitConsumedMessage | null): Promise<void> {
    if (!msg || !handler) return;
    if (closed || !active) {
      try {
        channel?.nack?.(msg, false, true);
      } catch {
        // best-effort
      }
      return;
    }

    inFlight += 1;
    try {
      const disposition = await handler({
        content: msg.content,
        deliveryTag: msg.fields.deliveryTag,
        redelivered: msg.fields.redelivered === true,
        routingKey: msg.fields.routingKey ?? null,
        messageId: msg.properties?.messageId ?? null,
      });

      if (disposition.action === "ack") {
        await ackMessage(msg);
      } else {
        await requeueNow(msg);
      }
    } catch (e) {
      logError("WEBHOOK_MESSAGE_NACK", {
        reason: "handler_exception",
        error: maskRabbitError(e),
      });
      await requeueNow(msg);
    } finally {
      inFlight = Math.max(0, inFlight - 1);
    }
  }

  async function ensureConsuming(): Promise<void> {
    if (!active || closed || !handler) return;
    const ch = await ensureChannel();
    if (consumerTag) return;
    if (typeof ch.consume !== "function") {
      throw new Error("canal RabbitMQ sem suporte a consume");
    }
    const { consumerTag: tag } = await ch.consume(
      config.queue,
      (msg) => {
        void handleDelivery(msg);
      },
      { noAck: false },
    );
    consumerTag = tag;
  }

  return {
    isConnected: () => channel != null,
    isActive: () => active,
    getState: () => ({
      connected: channel != null,
      active,
      inFlight,
      consecutiveFailures,
      nextAttemptInMs: Math.max(0, nextAttemptAt - now()),
    }),

    async start(nextHandler): Promise<void> {
      if (closed) throw new RabbitUnavailableError("consumer_closed", 0);
      handler = nextHandler;
      active = true;
      await ensureConsuming();
    },

    async stop(stopOptions): Promise<void> {
      active = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const tag = consumerTag;
      const ch = channel;
      consumerTag = null;
      if (tag && ch?.cancel) {
        try {
          await ch.cancel(tag);
        } catch {
          // best-effort
        }
      }

      const timeoutMs = stopOptions?.drainTimeoutMs ?? 30_000;
      const deadline = now() + timeoutMs;
      while (inFlight > 0 && now() < deadline) {
        await sleep(50);
      }
    },

    async close(): Promise<void> {
      closed = true;
      active = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      const ch = channel;
      const conn = connection;
      channel = null;
      connection = null;
      consumerTag = null;
      try {
        await ch?.close?.();
      } catch {
        // fechamento é best-effort
      }
      try {
        await conn?.close?.();
      } catch {
        // idem
      }
    },
  };
}
