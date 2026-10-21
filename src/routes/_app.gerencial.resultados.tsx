import { createFileRoute } from "@tanstack/react-router";
import { ResultadosTab } from "@/components/gerencial/resultados-tab";

export const Route = createFileRoute("/_app/gerencial/resultados")({
  component: GerencialResultadosPage,
});

function GerencialResultadosPage() {
  return <ResultadosTab />;
}
