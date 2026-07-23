/** Política de reserva/recuperação de processing — lógica pura (testável). */

export const DEFAULT_PROCESSING_STALE_MS = 120_000;
export const MIN_PROCESSING_STALE_MS = 120_000;
export const DEFAULT_MAX_SEND_ATTEMPTS = 3;
export const TRANSIENT_RETRY_DELAY_MS = 5_000;

export type SendErrorKind = "definitive" | "transient" | "unknown";

export type ClassifiedSendError = {
  kind: SendErrorKind;
  code: string;
  message: string;
};

const DEFINITIVE_ERROR_CODES = new Set([
  "invalid_recipient_phone",
  "empty_body_parameter",
  "missing_meta_template",
  "missing_evolution_instance",
  "missing_evolution_config",
  "meta_template_not_approved",
  "invalid_meta_template",
  "empty_message",
  "invalid_phone",
  "opt_out",
  "channel_unavailable",
  "missing_phone_number_id",
  "missing_token",
  "not_meta_channel",
  "service_window_closed",
]);

const TRANSIENT_ERROR_CODES = new Set([
  "meta_fetch_failed",
  "meta_api_error",
  "evolution_unreachable",
  "timeout",
  "network_error",
  "retry_scheduled",
  "stale_processing_released",
]);

const TRANSIENT_HTTP_PREFIXES = ["evolution_http_5", "evolution_http_429"];

export function readProcessingStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CAMPAIGN_PROCESSING_STALE_MS;
  const parsed = raw != null ? Number(raw) : DEFAULT_PROCESSING_STALE_MS;
  if (!Number.isFinite(parsed) || parsed < MIN_PROCESSING_STALE_MS) {
    return DEFAULT_PROCESSING_STALE_MS;
  }
  return parsed;
}

export function sanitizeWorkerErrorMessage(error: string): string {
  return error
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/\b\d{10,15}\b/g, "[phone]")
    .slice(0, 500);
}

export function classifyCampaignSendError(
  error: string,
  opts?: { httpStatus?: number },
): ClassifiedSendError {
  const code = error.split(":")[0]?.trim() || "unknown_error";
  const message = sanitizeWorkerErrorMessage(error);

  if (DEFINITIVE_ERROR_CODES.has(code)) {
    return { kind: "definitive", code, message };
  }
  if (TRANSIENT_ERROR_CODES.has(code)) {
    return { kind: "transient", code, message };
  }
  if (opts?.httpStatus != null) {
    if (opts.httpStatus === 429 || opts.httpStatus >= 500) {
      return { kind: "transient", code, message };
    }
    if (opts.httpStatus >= 400 && opts.httpStatus < 500) {
      return { kind: "definitive", code, message };
    }
  }
  if (TRANSIENT_HTTP_PREFIXES.some((p) => code.startsWith(p.replace(/\d$/, "")) || error.startsWith(p))) {
    return { kind: "transient", code, message };
  }
  if (/timeout|ECONNRESET|ENOTFOUND|AbortError|fetch failed/i.test(error)) {
    return { kind: "transient", code: code || "network_error", message };
  }
  if (/invalid|not_approved|missing_|empty_/i.test(code)) {
    return { kind: "definitive", code, message };
  }
  return { kind: "unknown", code, message };
}

export function classifyThrownError(e: unknown): ClassifiedSendError {
  if (e instanceof Error) {
    if (e.name === "AbortError") {
      return {
        kind: "transient",
        code: "timeout",
        message: sanitizeWorkerErrorMessage(e.message || "timeout"),
      };
    }
    return classifyCampaignSendError(e.message || e.name);
  }
  return classifyCampaignSendError(String(e));
}

/** Idade em ms do processing mais antigo com lock registrado. null = nenhum. */
export function oldestProcessingAgeMs(
  contacts: Array<{ status: string; processing_started_at_ms: number | null }>,
  nowMs: number,
): number | null {
  let oldest: number | null = null;
  for (const c of contacts) {
    if (c.status !== "processing") continue;
    if (c.processing_started_at_ms == null) continue;
    const age = nowMs - c.processing_started_at_ms;
    if (oldest == null || age > oldest) oldest = age;
  }
  return oldest;
}
