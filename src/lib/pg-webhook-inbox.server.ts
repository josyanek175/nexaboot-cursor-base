/**
 * Pool PostgreSQL exclusivo da ingestão da webhook_inbox.
 *
 * Separado do pool do nexaboot-web de propósito: saturação da UI, do fluxo
 * legado ou de campanhas não pode impedir a persistência de um webhook.
 * NÃO importar pg.server daqui.
 *
 * Dois limites diferentes protegem a ingestão:
 *  - aquisição de conexão: semáforo próprio com timeout (o postgres.js
 *    enfileira indefinidamente quando o pool está cheio);
 *  - execução da consulta: statement_timeout aplicado na conexão.
 */
import postgres from "postgres";
import type { PgSql } from "@/lib/pg-types";

let _inboxSql: PgSql | null = null;
let _configLogged = false;

function readIntEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min || floored > max) return fallback;
  return floored;
}

export const WEBHOOK_INBOX_DEFAULT_POOL_MAX = 3;
export const WEBHOOK_INBOX_DEFAULT_CONNECT_TIMEOUT_SEC = 10;
export const WEBHOOK_INBOX_DEFAULT_IDLE_TIMEOUT_SEC = 20;
export const WEBHOOK_INBOX_DEFAULT_ACQUIRE_TIMEOUT_MS = 3_000;
/** Payload grande (mídia base64) é lento de gravar; 5s rejeitaria evento válido. */
export const WEBHOOK_INBOX_DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

export function readWebhookInboxPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  return readIntEnv(env.WEBHOOK_INBOX_PG_POOL_MAX, WEBHOOK_INBOX_DEFAULT_POOL_MAX, 1, 20);
}

export function readWebhookInboxConnectTimeoutSec(env: NodeJS.ProcessEnv = process.env): number {
  return readIntEnv(
    env.WEBHOOK_INBOX_PG_CONNECT_TIMEOUT_SEC,
    WEBHOOK_INBOX_DEFAULT_CONNECT_TIMEOUT_SEC,
    1,
    60,
  );
}

export function readWebhookInboxIdleTimeoutSec(env: NodeJS.ProcessEnv = process.env): number {
  return readIntEnv(
    env.WEBHOOK_INBOX_PG_IDLE_TIMEOUT_SEC,
    WEBHOOK_INBOX_DEFAULT_IDLE_TIMEOUT_SEC,
    1,
    600,
  );
}

/** Prazo máximo para conseguir um slot de conexão do pool da inbox. */
export function readWebhookInboxAcquireTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readIntEnv(
    env.WEBHOOK_INBOX_PG_ACQUIRE_TIMEOUT_MS,
    WEBHOOK_INBOX_DEFAULT_ACQUIRE_TIMEOUT_MS,
    1,
    120_000,
  );
}

export function readWebhookInboxStatementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readIntEnv(
    env.WEBHOOK_INBOX_PG_STATEMENT_TIMEOUT_MS,
    WEBHOOK_INBOX_DEFAULT_STATEMENT_TIMEOUT_MS,
    1,
    600_000,
  );
}

/**
 * URL do banco da inbox.
 * Preferir WEBHOOK_INBOX_DATABASE_URL (permite apontar para um pooler ou
 * usuário próprio). Fallback documentado para DATABASE_URL.
 */
export function resolveWebhookInboxDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = env.WEBHOOK_INBOX_DATABASE_URL?.trim();
  if (dedicated) return dedicated;
  const fallback = env.DATABASE_URL?.trim();
  if (fallback) return fallback;
  throw new Error("WEBHOOK_INBOX_DATABASE_URL (ou DATABASE_URL) não configurada");
}

/** Cliente postgres.js exclusivo da inbox (lazy singleton do processo). */
export function getWebhookInboxSql(env: NodeJS.ProcessEnv = process.env): PgSql {
  if (_inboxSql) return _inboxSql;

  const url = resolveWebhookInboxDatabaseUrl(env);
  const max = readWebhookInboxPoolMax(env);
  const connectTimeoutSec = readWebhookInboxConnectTimeoutSec(env);
  const idleTimeoutSec = readWebhookInboxIdleTimeoutSec(env);
  const statementTimeoutMs = readWebhookInboxStatementTimeoutMs(env);

  _inboxSql = postgres(url, {
    ssl:
      url.includes("sslmode=require") || url.includes("supabase") || url.includes("neon")
        ? "require"
        : undefined,
    max,
    prepare: false,
    connect_timeout: connectTimeoutSec,
    idle_timeout: idleTimeoutSec,
    max_lifetime: 60 * 30,
    connection: {
      statement_timeout: statementTimeoutMs,
    },
  });

  if (!_configLogged) {
    _configLogged = true;
    console.log("[WEBHOOK_INBOX_POOL_CONFIG]", {
      poolMax: max,
      connectTimeoutSec,
      idleTimeoutSec,
      statementTimeoutMs,
      acquireTimeoutMs: readWebhookInboxAcquireTimeoutMs(env),
      maxLifetimeSec: 1800,
      hasDedicatedUrl: Boolean(env.WEBHOOK_INBOX_DATABASE_URL?.trim()),
      // a URL nunca é registrada
    });
  }

  return _inboxSql;
}

export async function closeWebhookInboxSql(): Promise<void> {
  if (!_inboxSql) return;
  const client = _inboxSql;
  _inboxSql = null;
  await client.end({ timeout: 5 });
}

export function isWebhookInboxSqlOpen(): boolean {
  return _inboxSql != null;
}

// ---------------------------------------------------------------------------
// Semáforo de aquisição de conexão
// ---------------------------------------------------------------------------

export class WebhookInboxAcquireTimeoutError extends Error {
  readonly code = "inbox_pool_acquire_timeout" as const;
  readonly waitedMs: number;

  constructor(waitedMs: number) {
    super("inbox_pool_acquire_timeout");
    this.name = "WebhookInboxAcquireTimeoutError";
    this.waitedMs = waitedMs;
  }
}

export function isWebhookInboxAcquireTimeout(
  error: unknown,
): error is WebhookInboxAcquireTimeoutError {
  return (
    error instanceof WebhookInboxAcquireTimeoutError ||
    (error instanceof Error && error.message === "inbox_pool_acquire_timeout")
  );
}

type SlotWaiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let _slotsInUse = 0;
let _slotWaiters: SlotWaiter[] = [];

export function getWebhookInboxPoolMetrics(env: NodeJS.ProcessEnv = process.env) {
  const max = readWebhookInboxPoolMax(env);
  return { max, inUse: _slotsInUse, waiting: _slotWaiters.length, idle: Math.max(0, max - _slotsInUse) };
}

function acquireSlot(max: number, timeoutMs: number): Promise<void> {
  if (_slotsInUse < max) {
    _slotsInUse += 1;
    return Promise.resolve();
  }

  const startedAt = Date.now();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      _slotWaiters = _slotWaiters.filter((w) => w.timer !== timer);
      reject(new WebhookInboxAcquireTimeoutError(Date.now() - startedAt));
    }, Math.max(1, timeoutMs));

    _slotWaiters.push({
      // Slot é transferido pelo liberador; _slotsInUse não muda aqui.
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject,
      timer,
    });
  });
}

function releaseSlot(): void {
  const next = _slotWaiters.shift();
  if (next) {
    next.resolve();
    return;
  }
  _slotsInUse = Math.max(0, _slotsInUse - 1);
}

/**
 * Executa `fn` com um slot de conexão garantido.
 * Estoura WebhookInboxAcquireTimeoutError se o pool não liberar a tempo — o
 * chamador traduz isso em 503, nunca em 200.
 */
export async function withWebhookInboxConnectionSlot<T>(
  fn: () => Promise<T>,
  options: { timeoutMs?: number; max?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const max = options.max ?? readWebhookInboxPoolMax(env);
  const timeoutMs = options.timeoutMs ?? readWebhookInboxAcquireTimeoutMs(env);

  await acquireSlot(max, timeoutMs);
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

/** Só testes. */
export function __resetWebhookInboxPoolGateForTests(): void {
  _slotWaiters.forEach((w) => clearTimeout(w.timer));
  _slotWaiters = [];
  _slotsInUse = 0;
}
