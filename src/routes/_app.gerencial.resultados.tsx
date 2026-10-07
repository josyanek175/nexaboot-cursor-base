import { createFileRoute } from "@tanstack/react-router";
import { GerencialPlaceholder } from "@/components/gerencial/gerencial-placeholder";

export const Route = createFileRoute("/_app/gerencial/resultados")({
  component: GerencialResultadosPage,
});

function GerencialResultadosPage() {
  return (
    <GerencialPlaceholder
      title="Resultados"
      description="Disparos, quem interagiu e quem demonstrou interesse — mesmos critérios da tela anterior de Campanhas → Resultados."
      legacyTo="/campanhas/resultados"
      legacyLabel="Abrir Resultados atuais (temporário)"
    />
  );
}
