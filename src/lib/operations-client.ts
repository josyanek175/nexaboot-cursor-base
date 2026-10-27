import { useEffect, useState } from "react";
export type OperationsProblem = {
  error: string;
  message: string;
  details?: { missingTables?: string[]; missingColumns?: string[] };
};
export class OperationsRequestError extends Error {
  constructor(public problem: OperationsProblem) {
    super(problem.message);
    this.name = "OperationsRequestError";
  }
}
export function asOperationsProblem(error: unknown): OperationsProblem {
  return error instanceof OperationsRequestError
    ? error.problem
    : {
        error: "operations_connection_failed",
        message: "Não foi possível acessar o serviço. Verifique sua conexão e tente novamente.",
      };
}
export async function readOperationsResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const fallback =
      response.status === 401
        ? "Sua sessão expirou. Entre novamente."
        : response.status === 403
          ? "Seu usuário não tem permissão para esta operação."
          : "Não foi possível carregar a configuração. Tente novamente ou solicite a verificação ao suporte.";
    const details = body?.details;
    throw new OperationsRequestError({
      error: typeof body?.error === "string" ? body.error : "operations_failed",
      message: typeof body?.message === "string" ? body.message : fallback,
      details:
        details && typeof details === "object"
          ? {
              missingTables: Array.isArray(details.missingTables)
                ? details.missingTables.filter((v: unknown) => typeof v === "string")
                : undefined,
              missingColumns: Array.isArray(details.missingColumns)
                ? details.missingColumns.filter((v: unknown) => typeof v === "string")
                : undefined,
            }
          : undefined,
    });
  }
  if (!body || typeof body !== "object")
    throw new OperationsRequestError({
      error: "operations_invalid_response",
      message: "O serviço retornou uma resposta inválida. Recarregue a tela.",
    });
  return body as T;
}
/** Descarta resultados de outra empresa, de uma tentativa anterior ou de uma tela já fechada. */
export function useOperationsData<T>(path: string, companyId: string | null, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const key = `${companyId ?? ""}:${path}:${attempt}`;
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    problem: OperationsProblem | null;
    loading: boolean;
  }>({ key: "", data: null, problem: null, loading: false });
  useEffect(() => {
    if (!enabled || !companyId) return;
    const abort = new AbortController();
    let cancelled = false;
    setState({ key, data: null, problem: null, loading: true });
    fetch(path, { credentials: "same-origin", cache: "no-store", signal: abort.signal })
      .then((response) => readOperationsResponse<T>(response))
      .then((data) => {
        if (!cancelled) setState({ key, data, problem: null, loading: false });
      })
      .catch((error) => {
        if (!cancelled)
          setState({ key, data: null, problem: asOperationsProblem(error), loading: false });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [key, path, companyId, enabled]);
  const current = !!(enabled && companyId && state.key === key);
  return {
    data: current ? state.data : null,
    problem: current ? state.problem : null,
    loading: !!(enabled && companyId && (!current || state.loading)),
    reload: () => setAttempt((v) => v + 1),
  };
}
