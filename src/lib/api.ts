// Cliente de API do próprio nexaboot-web (mesma origem, prefixo /api).
// Fase 1 Evolution: paramos de depender de VITE_API_URL externo.
// Mantém compatibilidade: se VITE_API_URL for definido, ele é respeitado.
const API_URL = import.meta.env.VITE_API_URL || "/api";

export async function apiGet(path: string) {
  const response = await fetch(`${API_URL}${path}`, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Erro API: ${response.status}`);
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
    let detail = "";
    try {
      const data = await response.json();
      detail = data?.error ? ` (${data.error})` : "";
    } catch {
      // resposta sem corpo JSON
    }
    throw new Error(`Erro API: ${response.status}${detail}`);
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
    let detail = "";
    try {
      const data = await response.json();
      detail = data?.error ? ` (${data.error})` : "";
    } catch {
      // resposta sem corpo JSON
    }
    throw new Error(`Erro API: ${response.status}${detail}`);
  }
  return response.json();
}

export async function apiDelete(path: string) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Erro API: ${response.status}`);
  }
  return response.json();
}
