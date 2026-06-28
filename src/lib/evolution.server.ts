// Client server-only da Evolution API. Lê as credenciais de process.env e
// NUNCA expõe a API key ao browser. Todas as chamadas saem do backend.
// Não persiste sessão da Evolution no banco do NexaBoot.

const TIMEOUT_MS = 20_000;

export interface EvoConfig {
  apiUrl: string;
  apiKey: string;
  webhookBase: string;
  webhookSecret: string;
}

export function evoConfig(): EvoConfig {
  return {
    apiUrl: (process.env.EVOLUTION_API_URL || "").replace(/\/+$/, ""),
    apiKey: process.env.EVOLUTION_API_KEY || "",
    webhookBase: (process.env.WEBHOOK_PUBLIC_URL || "").replace(/\/+$/, ""),
    webhookSecret: process.env.EVOLUTION_WEBHOOK_SECRET || "",
  };
}

export function hasEvoConfig(): boolean {
  const c = evoConfig();
  return !!c.apiUrl && !!c.apiKey;
}

export interface EvoResult {
  ok: boolean;
  status: number;
  data: any;
  error?: string;
}

async function evoFetch(path: string, init: RequestInit = {}): Promise<EvoResult> {
  const { apiUrl, apiKey } = evoConfig();
  if (!apiUrl || !apiKey) {
    return { ok: false, status: 0, data: null, error: "missing_config" };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", apikey: apiKey, ...(init.headers ?? {}) },
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const error =
        res.status === 401 || res.status === 403 ? "unauthorized_check_api_key" : "evolution_http_error";
      console.error("[EVOLUTION_ERROR]", { path, status: res.status, body: String(text).slice(0, 400) });
      return { ok: false, status: res.status, data, error };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    console.error("[EVOLUTION_ERROR]", { path, error: e instanceof Error ? e.message : String(e) });
    return { ok: false, status: 0, data: null, error: isAbort ? "timeout" : "evolution_unreachable" };
  } finally {
    clearTimeout(t);
  }
}

/** Mapeia o estado bruto da Evolution para os status do NexaBoot. */
export function mapEvoStatus(state: unknown): "disconnected" | "connecting" | "qrcode" | "connected" | "error" {
  const s = String(state ?? "").toLowerCase();
  if (s === "open") return "connected";
  if (s === "connecting") return "connecting";
  if (s === "close" || s === "closed") return "disconnected";
  if (s.includes("qr")) return "qrcode";
  if (s === "error") return "error";
  return "disconnected";
}

export async function listInstances(): Promise<EvoResult> {
  return evoFetch("/instance/fetchInstances", { method: "GET" });
}

export async function instanceExists(instance: string): Promise<boolean> {
  const r = await listInstances();
  if (!r.ok || !Array.isArray(r.data)) return false;
  return r.data.some((d: any) => (d.instance?.instanceName ?? d.instanceName ?? d.name) === instance);
}

export async function instanceState(instance: string): Promise<EvoResult> {
  return evoFetch(`/instance/connectionState/${encodeURIComponent(instance)}`, { method: "GET" });
}

export async function createInstanceEvo(instance: string): Promise<EvoResult> {
  return evoFetch("/instance/create", {
    method: "POST",
    body: JSON.stringify({ instanceName: instance, integration: "WHATSAPP-BAILEYS", qrcode: true }),
  });
}

export async function connectInstanceEvo(instance: string): Promise<EvoResult> {
  return evoFetch(`/instance/connect/${encodeURIComponent(instance)}`, { method: "GET" });
}

export async function logoutInstanceEvo(instance: string): Promise<EvoResult> {
  return evoFetch(`/instance/logout/${encodeURIComponent(instance)}`, { method: "DELETE" });
}

/** URL pública do webhook do NexaBoot (com token), ou null se não configurada. */
export function webhookUrl(): string | null {
  const { webhookBase, webhookSecret } = evoConfig();
  if (!webhookBase) return null;
  const u = `${webhookBase}/api/webhooks/evolution`;
  return webhookSecret ? `${u}?token=${encodeURIComponent(webhookSecret)}` : u;
}

const WEBHOOK_EVENTS = [
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "CONNECTION_UPDATE",
  "SEND_MESSAGE",
  "QRCODE_UPDATED",
];

/** Configura o webhook da instância (tenta formato v2 e cai para v1). Best-effort. */
export async function setInstanceWebhook(instance: string): Promise<EvoResult> {
  const url = webhookUrl();
  if (!url) return { ok: false, status: 0, data: null, error: "missing_webhook_public_url" };
  const v2 = await evoFetch(`/webhook/set/${encodeURIComponent(instance)}`, {
    method: "POST",
    body: JSON.stringify({
      webhook: { enabled: true, url, webhookByEvents: false, base64: true, events: WEBHOOK_EVENTS },
    }),
  });
  if (v2.ok) return v2;
  return evoFetch(`/webhook/set/${encodeURIComponent(instance)}`, {
    method: "POST",
    body: JSON.stringify({ url, enabled: true, webhook_by_events: false, events: WEBHOOK_EVENTS }),
  });
}

/** Extrai o QR Code (data URL) de uma resposta da Evolution. */
export function extractQr(data: any): string | null {
  if (!data) return null;
  const b64 = data?.qrcode?.base64 ?? data?.base64 ?? (typeof data?.qrcode === "string" ? data.qrcode : null);
  if (!b64 || typeof b64 !== "string") return null;
  return b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
}
