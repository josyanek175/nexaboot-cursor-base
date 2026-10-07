import { createFileRoute } from "@tanstack/react-router";
import { GerencialPlaceholder } from "@/components/gerencial/gerencial-placeholder";

export const Route = createFileRoute("/_app/gerencial/bloqueados")({
  component: GerencialBloqueadosPage,
});

function GerencialBloqueadosPage() {
  return (
    <GerencialPlaceholder
      title="Bloqueados"
      description="Números na janela de disparo e configuração 7/10/30 — mesma regra da tela anterior de Campanhas → Bloqueados."
      legacyTo="/campanhas/bloqueados"
      legacyLabel="Abrir Bloqueados atuais (temporário)"
    />
  );
}
