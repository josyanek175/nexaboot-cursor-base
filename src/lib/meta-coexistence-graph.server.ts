/**
 * Graph helpers para Embedded Signup — sem logar tokens/codes.
 */
import { getMetaCoexistencePublicConfig } from "@/lib/meta-coexistence-policy.server";

export type GraphWhatsAppAssets = {
  wabaId: string;
  phoneNumberId: string;
  businessId: string | null;
  displayPhoneNumber: string | null;
};

export type SessionInfoHint = {
  waba_id?: string | null;
  phone_number_id?: string | null;
  business_id?: string | null;
  display_phone_number?: string | null;
};

type GraphError = { error: "graph_assets_unavailable" | "graph_phone_invalid" | "graph_request_failed" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function graphGet(
  path: string,
  accessToken: string,
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false }> {
  const pub = getMetaCoexistencePublicConfig();
  const url = new URL(`https://graph.facebook.com/${pub.graphVersion}${path}`);
  url.searchParams.set("access_token", accessToken);
  try {
    const res = await fetch(url.toString(), { method: "GET" });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.error) {
      console.error("[META_COEXISTENCE_GRAPH_FAIL]", {
        path: path.split("?")[0],
        status: res.status,
        hasError: Boolean(json.error),
      });
      return { ok: false };
    }
    return { ok: true, json };
  } catch {
    console.error("[META_COEXISTENCE_GRAPH_FAIL]", { path: path.split("?")[0], network: true });
    return { ok: false };
  }
}

async function verifyPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
): Promise<{ displayPhoneNumber: string | null } | null> {
  const result = await graphGet(
    `/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name`,
    accessToken,
  );
  if (!result.ok) return null;
  const id = readString(result.json.id);
  if (id && id !== phoneNumberId) return null;
  return {
    displayPhoneNumber: readString(result.json.display_phone_number),
  };
}

async function listPhoneNumbersForWaba(
  wabaId: string,
  accessToken: string,
): Promise<Array<{ id: string; displayPhoneNumber: string | null }>> {
  const result = await graphGet(
    `/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number`,
    accessToken,
  );
  if (!result.ok) return [];
  const data = Array.isArray(result.json.data) ? result.json.data : [];
  const out: Array<{ id: string; displayPhoneNumber: string | null }> = [];
  for (const item of data) {
    const rec = asRecord(item);
    const id = rec ? readString(rec.id) : null;
    if (!id) continue;
    out.push({
      id,
      displayPhoneNumber: rec ? readString(rec.display_phone_number) : null,
    });
  }
  return out;
}

/**
 * Resolve WABA + phone a partir do token (e hints opcionais do Embedded Signup session info).
 * Hints são IDs públicos — nunca tokens. Sempre validados na Graph quando possível.
 */
export async function resolveWhatsAppAssetsFromToken(
  accessToken: string,
  hint?: SessionInfoHint | null,
): Promise<GraphWhatsAppAssets | GraphError> {
  const hintWaba = readString(hint?.waba_id ?? null);
  const hintPhone = readString(hint?.phone_number_id ?? null);
  const hintBusiness = readString(hint?.business_id ?? null);
  const hintDisplay = readString(hint?.display_phone_number ?? null);

  if (hintWaba && hintPhone) {
    const verified = await verifyPhoneNumber(hintPhone, accessToken);
    if (!verified) {
      // Tenta listar phones do WABA e confirmar membership
      const phones = await listPhoneNumbersForWaba(hintWaba, accessToken);
      const match = phones.find((p) => p.id === hintPhone);
      if (!match) return { error: "graph_phone_invalid" };
      return {
        wabaId: hintWaba,
        phoneNumberId: hintPhone,
        businessId: hintBusiness,
        displayPhoneNumber: match.displayPhoneNumber ?? hintDisplay,
      };
    }
    return {
      wabaId: hintWaba,
      phoneNumberId: hintPhone,
      businessId: hintBusiness,
      displayPhoneNumber: verified.displayPhoneNumber ?? hintDisplay,
    };
  }

  if (hintWaba) {
    const phones = await listPhoneNumbersForWaba(hintWaba, accessToken);
    if (phones.length === 0) return { error: "graph_assets_unavailable" };
    const chosen = hintPhone
      ? phones.find((p) => p.id === hintPhone)
      : phones[0];
    if (!chosen) return { error: "graph_phone_invalid" };
    return {
      wabaId: hintWaba,
      phoneNumberId: chosen.id,
      businessId: hintBusiness,
      displayPhoneNumber: chosen.displayPhoneNumber ?? hintDisplay,
    };
  }

  // Sem WABA hint: tenta debug_token granular scopes / target ids (sem logar token).
  const pub = getMetaCoexistencePublicConfig();
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (pub.appId && appSecret) {
    const debugUrl = new URL(`https://graph.facebook.com/${pub.graphVersion}/debug_token`);
    debugUrl.searchParams.set("input_token", accessToken);
    debugUrl.searchParams.set("access_token", `${pub.appId}|${appSecret}`);
    try {
      const res = await fetch(debugUrl.toString(), { method: "GET" });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const data = asRecord(json.data);
      const granular = Array.isArray(data?.granular_scopes) ? data!.granular_scopes : [];
      for (const scope of granular) {
        const scopeRec = asRecord(scope);
        const targetIds = Array.isArray(scopeRec?.target_ids)
          ? scopeRec!.target_ids.map((x) => readString(x)).filter(Boolean)
          : [];
        for (const targetId of targetIds) {
          if (!targetId) continue;
          const phones = await listPhoneNumbersForWaba(targetId, accessToken);
          if (phones.length > 0) {
            return {
              wabaId: targetId,
              phoneNumberId: phones[0].id,
              businessId: hintBusiness,
              displayPhoneNumber: phones[0].displayPhoneNumber ?? hintDisplay,
            };
          }
        }
      }
    } catch {
      console.error("[META_COEXISTENCE_GRAPH_FAIL]", { path: "/debug_token", network: true });
    }
  }

  return { error: "graph_assets_unavailable" };
}

/**
 * Troca authorization code por access_token (uma vez).
 * Nunca loga code ou token.
 */
export async function exchangeAuthorizationCode(code: string): Promise<
  | { ok: true; accessToken: string; expiresIn: number | null }
  | { ok: false; reason: "not_configured" | "rejected" | "failed" }
> {
  const pub = getMetaCoexistencePublicConfig();
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!pub.appId || !appSecret) {
    return { ok: false, reason: "not_configured" };
  }

  const url = new URL(`https://graph.facebook.com/${pub.graphVersion}/oauth/access_token`);
  url.searchParams.set("client_id", pub.appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);

  try {
    const res = await fetch(url.toString(), { method: "GET" });
    const graphJson = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!graphJson.access_token || typeof graphJson.access_token !== "string") {
      console.error("[META_COEXISTENCE_EXCHANGE_REJECT]", {
        graphStatus: res.status,
        hasError: Boolean(graphJson.error),
      });
      return { ok: false, reason: "rejected" };
    }
    return {
      ok: true,
      accessToken: graphJson.access_token,
      expiresIn: typeof graphJson.expires_in === "number" ? graphJson.expires_in : null,
    };
  } catch {
    console.error("[META_COEXISTENCE_EXCHANGE_FAIL]", { network: true });
    return { ok: false, reason: "failed" };
  }
}
