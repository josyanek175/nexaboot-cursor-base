// Evolution API — adapter client-side puro com fallback mock.
//
// IMPORTANTE: Em produção, NUNCA enviar o EVOLUTION_API_KEY do browser. A
// recomendação é usar `evolution-proxy.functions.ts` (server-fn) que faz a
// chamada server-to-server lendo `process.env.EVOLUTION_API_URL` /
// `EVOLUTION_API_KEY`. Para a Fase 6, esta camada já abstrai a interface
// para que a tela de Canais use o mesmo contrato — basta trocar o transport.
//
// Modo MOCK é ativado quando `config.apiUrl` aponta para `*.local` ou está
// vazio, permitindo desenvolver/demonstrar sem credenciais reais.

import type { EvolutionConfig } from "./mocks";

export type EvolutionInstance = {
  instanceName: string;
  status: "open" | "close" | "connecting" | "qrcode";
  phone?: string;
  profileName?: string;
};

export type SendResult = {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
};

function isMock(cfg?: Partial<EvolutionConfig>): boolean {
  if (!cfg) return true;
  if (!cfg.apiUrl || !cfg.apiKey) return true;
  if (cfg.apiUrl.endsWith(".local") || cfg.apiUrl.includes("evolution.local")) return true;
  return false;
}

async function evoFetch(cfg: EvolutionConfig, path: string, init: RequestInit = {}) {
  const url = `${cfg.apiUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.apiKey,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Evolution ${res.status}: ${txt || res.statusText}`);
  }
  return res.json();
}

// ─── Service contract ────────────────────────────────────────────────────────

export async function fetchInstances(cfg: EvolutionConfig): Promise<EvolutionInstance[]> {
  if (isMock(cfg)) {
    return [
      { instanceName: cfg.instanceName || "demo-instance", status: "open", phone: "+55 11 90000-0001", profileName: "Demo" },
      { instanceName: "secundaria", status: "close" },
    ];
  }
  const data = await evoFetch(cfg, "/instance/fetchInstances");
  return (Array.isArray(data) ? data : []).map((d: any) => ({
    instanceName: d.instance?.instanceName ?? d.instanceName,
    status: d.instance?.status ?? d.status ?? "close",
    phone: d.instance?.owner ?? d.owner,
    profileName: d.instance?.profileName ?? d.profileName,
  }));
}

export async function getInstanceStatus(cfg: EvolutionConfig): Promise<EvolutionInstance["status"]> {
  if (isMock(cfg)) return "open";
  const data = await evoFetch(cfg, `/instance/connectionState/${encodeURIComponent(cfg.instanceName)}`);
  return data?.state ?? data?.instance?.state ?? "close";
}

export async function createInstance(cfg: EvolutionConfig): Promise<{ ok: boolean; raw?: unknown }> {
  if (isMock(cfg)) return { ok: true };
  const data = await evoFetch(cfg, "/instance/create", {
    method: "POST",
    body: JSON.stringify({
      instanceName: cfg.instanceName,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
    }),
  });
  return { ok: true, raw: data };
}

export async function connectInstance(cfg: EvolutionConfig): Promise<{ ok: boolean; raw?: unknown }> {
  if (isMock(cfg)) return { ok: true };
  const data = await evoFetch(cfg, `/instance/connect/${encodeURIComponent(cfg.instanceName)}`);
  return { ok: true, raw: data };
}

/** Retorna data URL (image/png) com o QR Code ou null. */
export async function getQRCode(cfg: EvolutionConfig): Promise<string | null> {
  if (isMock(cfg)) {
    // QR mock: pixel cinza 8x8 em base64
    return "data:image/svg+xml;utf8," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>
         <rect width='100' height='100' fill='#fff'/>
         <text x='50' y='52' font-size='9' text-anchor='middle' fill='#111'>QR MOCK</text>
         <text x='50' y='65' font-size='6' text-anchor='middle' fill='#666'>${cfg.instanceName || "instance"}</text>
       </svg>`
    );
  }
  const data = await evoFetch(cfg, `/instance/connect/${encodeURIComponent(cfg.instanceName)}`);
  const b64 = data?.qrcode?.base64 ?? data?.base64 ?? null;
  if (!b64) return null;
  return b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
}

export async function logoutInstance(cfg: EvolutionConfig): Promise<{ ok: boolean }> {
  if (isMock(cfg)) return { ok: true };
  await evoFetch(cfg, `/instance/logout/${encodeURIComponent(cfg.instanceName)}`, { method: "DELETE" });
  return { ok: true };
}

export async function sendText(cfg: EvolutionConfig, to: string, text: string): Promise<SendResult> {
  if (isMock(cfg)) {
    return { ok: true, providerMessageId: `mock-${Date.now()}` };
  }
  try {
    const data = await evoFetch(cfg, `/message/sendText/${encodeURIComponent(cfg.instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ number: to.replace(/\D/g, ""), text }),
    });
    return { ok: true, providerMessageId: data?.key?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send error" };
  }
}

export type EvolutionMediaType = "image" | "audio" | "video" | "document";

export async function sendMedia(
  cfg: EvolutionConfig,
  to: string,
  mediaUrl: string,
  mediaType: EvolutionMediaType,
  fileName?: string,
): Promise<SendResult> {
  if (isMock(cfg)) return { ok: true, providerMessageId: `mock-${Date.now()}` };
  try {
    const data = await evoFetch(cfg, `/message/sendMedia/${encodeURIComponent(cfg.instanceName)}`, {
      method: "POST",
      body: JSON.stringify({
        number: to.replace(/\D/g, ""),
        mediatype: mediaType,
        media: mediaUrl,
        fileName: fileName ?? "arquivo",
      }),
    });
    return { ok: true, providerMessageId: data?.key?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send error" };
  }
}

export async function configureWebhook(cfg: EvolutionConfig, webhookUrl: string): Promise<{ ok: boolean }> {
  if (isMock(cfg)) return { ok: true };
  await evoFetch(cfg, `/webhook/set/${encodeURIComponent(cfg.instanceName)}`, {
    method: "POST",
    body: JSON.stringify({
      url: webhookUrl,
      enabled: true,
      events: [
        cfg.events.text && "MESSAGES_UPSERT",
        "MESSAGES_UPDATE",
        "CONNECTION_UPDATE",
        "SEND_MESSAGE",
      ].filter(Boolean),
    }),
  });
  return { ok: true };
}

// ─── Helper para a página de canais ─────────────────────────────────────────
export function defaultEvolutionConfig(channelId: string, tenantId: string): EvolutionConfig {
  return {
    apiUrl: "https://evolution.local",
    apiKey: "",
    instanceName: `nexa-${tenantId}-${channelId}`.slice(0, 40),
    webhookUrl: `${typeof window !== "undefined" ? window.location.origin : ""}/api/public/webhooks/evolution`,
    events: { text: true, image: true, audio: true, document: true, video: true },
  };
}
