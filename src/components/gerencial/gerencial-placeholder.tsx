import { Link } from "@tanstack/react-router";

type Props = {
  title: string;
  description: string;
  /** Rota legada ainda funcional até a aba receber o conteúdo completo. */
  legacyTo?: "/campanhas/resultados" | "/campanhas/custos" | "/campanhas/bloqueados";
  legacyLabel?: string;
};

/** Placeholder da FASE 1 — conteúdo real entra nas fases seguintes. */
export function GerencialPlaceholder({ title, description, legacyTo, legacyLabel }: Props) {
  return (
    <section className="rounded-xl border border-dashed border-border bg-card p-8 text-center shadow-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">{description}</p>
      <p className="mt-4 text-xs text-muted-foreground">
        Estrutura e navegação prontas · dados e gráficos nas próximas fases
      </p>
      {legacyTo && (
        <Link
          to={legacyTo}
          className="mt-5 inline-flex items-center rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent"
        >
          {legacyLabel ?? "Abrir versão atual (temporário)"}
        </Link>
      )}
    </section>
  );
}
