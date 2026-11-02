import type { OperationsProblem } from "@/lib/operations-client";
export function OperationsProblemPanel({
  problem,
  onRetry,
  disabled = false,
}: {
  problem: OperationsProblem | null;
  onRetry: () => void;
  disabled?: boolean;
}) {
  if (!problem) return null;
  const tables = problem.details?.missingTables ?? [],
    columns = problem.details?.missingColumns ?? [];
  return (
    <section
      role="alert"
      className="my-4 rounded-md border border-destructive/30 bg-destructive/5 p-4"
    >
      <p className="text-sm">{problem.message}</p>
      {(tables.length > 0 || columns.length > 0) && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer">Detalhes para o suporte</summary>
          {tables.length > 0 && (
            <p className="mt-2 break-words">Tabelas ausentes: {tables.join(", ")}</p>
          )}
          {columns.length > 0 && (
            <p className="mt-2 break-words">Campos ausentes: {columns.join(", ")}</p>
          )}
        </details>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={onRetry}
        className="mt-3 rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
      >
        Tentar novamente
      </button>
    </section>
  );
}
