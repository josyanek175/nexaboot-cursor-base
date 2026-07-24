// Envio de documento outbound pela Evolution API 2.3.7 (sendMedia).

export type EvolutionDocumentSendInput = {
  apiUrl: string;
  apiKey: string;
  instance: string;
  number: string;
  base64: string;
  mimeType: string;
  fileName: string;
  caption?: string | null;
};

export type EvolutionDocumentSendResult =
  | { ok: true; providerMessageId: string | null; httpStatus: number }
  | { ok: false; error: string; userMessage: string; httpStatus?: number };

function sanitizeProviderError(body: string, status?: number): string {
  const trimmed = body.trim().slice(0, 500);
  if (!trimmed) return status ? `Evolution HTTP ${status}` : "evolution_send_failed";
  return trimmed;
}

/** POST /message/sendMedia/{instance} com mediatype=document. */
export async function sendEvolutionDocument(
  input: EvolutionDocumentSendInput,
  fetchFn: typeof fetch = fetch,
): Promise<EvolutionDocumentSendResult> {
  const base = input.apiUrl.replace(/\/+$/, "");
  const endpoint = `${base}/message/sendMedia/${encodeURIComponent(input.instance)}`;

  console.log("[EVOLUTION_DOCUMENT_SEND_START]", {
    instance: input.instance,
    number: input.number.replace(/\d(?=\d{4})/g, "*"),
    mimeType: input.mimeType,
    fileName: input.fileName,
    size: input.base64.length,
  });

  const payload: Record<string, unknown> = {
    number: input.number.replace(/\D/g, ""),
    mediatype: "document",
    mimetype: input.mimeType,
    media: input.base64,
    fileName: input.fileName,
  };
  if (input.caption?.trim()) payload.caption = input.caption.trim();

  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: input.apiKey },
      body: JSON.stringify(payload),
    });
    const body = await res.text().catch(() => "");

    if (!res.ok) {
      const error = sanitizeProviderError(body, res.status);
      console.error("[EVOLUTION_DOCUMENT_SEND_FAIL]", {
        status: res.status,
        error: error.slice(0, 200),
        instance: input.instance,
      });
      return {
        ok: false,
        error,
        userMessage: "Não foi possível enviar o documento",
        httpStatus: res.status,
      };
    }

    let providerMessageId: string | null = null;
    try {
      providerMessageId = JSON.parse(body)?.key?.id ?? null;
    } catch {
      /* resposta sem key.id */
    }

    console.log("[EVOLUTION_DOCUMENT_SEND_OK]", {
      instance: input.instance,
      providerMessageId,
      httpStatus: res.status,
    });

    return { ok: true, providerMessageId, httpStatus: res.status };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[EVOLUTION_DOCUMENT_SEND_FAIL]", { error: error.slice(0, 200) });
    return {
      ok: false,
      error,
      userMessage: "Não foi possível enviar o documento",
    };
  }
}
