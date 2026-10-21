/**
 * Janela progressiva de disparo entre campanhas (por company_id + telefone).
 * 1º envio → N dias; 2º → M dias; 3º+ → P dias (configurável por empresa).
 */

export const DISPATCH_WINDOW_SKIP_REASON = "dispatch_window";

/** Texto exibido na lista da campanha e na página de bloqueados. */
export const DISPATCH_WINDOW_LABEL = "Número em janela de disparo";

export type DispatchWindowSettings = {
  firstWindowDays: number;
  secondWindowDays: number;
  thirdWindowDays: number;
};

export const DEFAULT_DISPATCH_WINDOW_SETTINGS: DispatchWindowSettings = {
  firstWindowDays: 7,
  secondWindowDays: 10,
  thirdWindowDays: 30,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Dias de bloqueio após `sendCount` disparos bem-sucedidos. */
export function windowDaysForSendCount(
  sendCount: number,
  settings: DispatchWindowSettings = DEFAULT_DISPATCH_WINDOW_SETTINGS,
): number {
  if (sendCount <= 0) return 0;
  if (sendCount === 1) return settings.firstWindowDays;
  if (sendCount === 2) return settings.secondWindowDays;
  return settings.thirdWindowDays;
}

export type DispatchBlockState = {
  blocked: boolean;
  sendCount: number;
  windowDays: number;
  lastSentAt: Date;
  liberatesAt: Date;
};

/** Calcula se o número está bloqueado com base no histórico de envios. */
export function computeDispatchBlock(opts: {
  sendCount: number;
  lastSentAt: Date | string;
  now?: Date;
  settings?: DispatchWindowSettings;
}): DispatchBlockState | null {
  const sendCount = Math.max(0, Math.floor(opts.sendCount));
  if (sendCount <= 0) return null;

  const settings = opts.settings ?? DEFAULT_DISPATCH_WINDOW_SETTINGS;
  const lastSentAt =
    opts.lastSentAt instanceof Date ? opts.lastSentAt : new Date(opts.lastSentAt);
  if (Number.isNaN(lastSentAt.getTime())) return null;

  const windowDays = windowDaysForSendCount(sendCount, settings);
  const liberatesAt = new Date(lastSentAt.getTime() + windowDays * MS_PER_DAY);
  const now = opts.now ?? new Date();

  return {
    blocked: now.getTime() < liberatesAt.getTime(),
    sendCount,
    windowDays,
    lastSentAt,
    liberatesAt,
  };
}

export function clampDispatchWindowDays(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  if (rounded < 1) return 1;
  if (rounded > 365) return 365;
  return rounded;
}

export function normalizeDispatchWindowSettings(raw: {
  firstWindowDays?: unknown;
  secondWindowDays?: unknown;
  thirdWindowDays?: unknown;
}): DispatchWindowSettings {
  return {
    firstWindowDays: clampDispatchWindowDays(
      raw.firstWindowDays,
      DEFAULT_DISPATCH_WINDOW_SETTINGS.firstWindowDays,
    ),
    secondWindowDays: clampDispatchWindowDays(
      raw.secondWindowDays,
      DEFAULT_DISPATCH_WINDOW_SETTINGS.secondWindowDays,
    ),
    thirdWindowDays: clampDispatchWindowDays(
      raw.thirdWindowDays,
      DEFAULT_DISPATCH_WINDOW_SETTINGS.thirdWindowDays,
    ),
  };
}
