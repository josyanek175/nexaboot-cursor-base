// Contratos comuns para providers WhatsApp (Evolution + Meta Cloud API).

export type WhatsAppProviderKind = "evolution" | "meta";

export const META_CHANNEL_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "ERROR",
  "BLOCKED",
  "DISCONNECTED",
  "PENDING_REVIEW",
] as const;

export type MetaChannelStatus = (typeof META_CHANNEL_STATUSES)[number];

export const EVOLUTION_CHANNEL_STATUSES = [
  "disconnected",
  "connecting",
  "qrcode",
  "connected",
  "error",
] as const;

export type EvolutionChannelStatus = (typeof EVOLUTION_CHANNEL_STATUSES)[number];

export type TokenStatus = "valid" | "expired" | "revoked" | "missing" | "pending";

/** Visão pública de canal — nunca inclui tokens ou ciphertext. */
export interface WhatsAppChannelRecord {
  id: string;
  companyId: string;
  name: string | null;
  channelType: WhatsAppProviderKind;
  status: string;
  evolutionInstanceName: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  displayPhoneNumber: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  businessId: string | null;
  tokenStatus: TokenStatus | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastWebhookAt: string | null;
  lastConnectedAt: string | null;
}

export interface MetaGraphErrorDetail {
  code?: string | number | null;
  type?: string | null;
  message?: string | null;
  error_subcode?: string | number | null;
  fbtrace_id?: string | null;
  httpStatus?: number;
  source?: "phone_number" | "waba_phone_numbers" | "local";
  tokenReason?: string;
}

export interface ProviderStatusResult {
  ok: boolean;
  provider: WhatsAppProviderKind;
  status: string;
  tokenStatus?: TokenStatus | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  lastWebhookAt?: string | null;
  configured?: boolean;
  error?: string;
  graphData?: Record<string, unknown> | null;
  wabaPhoneNumbers?: unknown;
  metaError?: MetaGraphErrorDetail | null;
}

export interface ProviderSendResult {
  ok: boolean;
  error?: string;
  notImplemented?: boolean;
  providerMessageId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** Interface mínima de provider — envio será implementado em fase posterior. */
export interface WhatsAppProvider {
  readonly kind: WhatsAppProviderKind;
  getStatus(channel: WhatsAppChannelRecord): Promise<ProviderStatusResult>;
  sendText(
    _channel: WhatsAppChannelRecord,
    _to: string,
    _body: string,
  ): Promise<ProviderSendResult>;
}

export function normalizeProviderKind(
  channelType: string | null | undefined,
): WhatsAppProviderKind | null {
  const t = String(channelType ?? "").toLowerCase();
  if (t === "evolution") return "evolution";
  if (t === "meta") return "meta";
  return null;
}

export function normalizeTokenStatus(value: string | null | undefined): TokenStatus | null {
  const v = String(value ?? "").toLowerCase();
  if (v === "valid" || v === "expired" || v === "revoked" || v === "missing" || v === "pending") {
    return v;
  }
  return null;
}
