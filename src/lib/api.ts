const API_URL = import.meta.env.VITE_API_URL;

export async function apiGet(path: string) {
  const response = await fetch(`${API_URL}${path}`);
  if (!response.ok) {
    throw new Error(`Erro API: ${response.status}`);
  }
  return response.json();
}

export async function apiPost(path: string, body?: any) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    throw new Error(`Erro API: ${response.status}`);
  }
  return response.json();
}
