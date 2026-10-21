// Cliente de API do próprio nexaboot-web (mesma origem, prefixo /api).
// Fase 1 Evolution: paramos de depender de VITE_API_URL externo.
// Mantém compatibilidade: se VITE_API_URL for definido, ele é respeitado.
const API_URL = import.meta.env.VITE_API_URL || "/api";

export type ApiErrorBody = {
  error?: string;
  code?: string;
  reason?: string;
  message?: string;
  provider?: string;
  details?: Record<string, unknown>;
};

/** Erro HTTP da API local com corpo JSON preservado para a UI. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    const userMessage =
      body.message?.trim() ||
      body.error?.trim() ||
      `Erro API: ${status}`;
    super(userMessage);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

async function parseErrorResponse(response: Response): Promise<ApiRequestError> {
  let body: ApiErrorBody = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = {};
  }
  return new ApiRequestError(response.status, body);
}

export function getApiErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Falha na requisição.";
}

export async function apiGet(path: string) {
  const response = await fetch(`${API_URL}${path}`, { credentials: "include" });
  if (!response.ok) {
    throw await parseErrorResponse(response);
  }
  return response.json();
}

export async function apiPost(path: string, body?: any) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    throw await parseErrorResponse(response);
  }
  return response.json();
}

export async function apiPostForm(path: string, form: FormData) {
  // NÃO definir Content-Type: o browser monta o boundary do multipart.
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!response.ok) {
    throw await parseErrorResponse(response);
  }
  return response.json();
}

export async function apiPut(path: string, body?: any) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    throw await parseErrorResponse(response);
  }
  return response.json();
}

export async function apiDelete(path: string) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    throw await parseErrorResponse(response);
  }
  return response.json();
}

export async function apiPatch(path: string, body?: unknown) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    throw await parseErrorResponse(response);
  }
  return response.json();
}
