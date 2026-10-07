import { createFileRoute } from "@tanstack/react-router";
import { GerencialPlaceholder } from "@/components/gerencial/gerencial-placeholder";

export const Route = createFileRoute("/_app/gerencial/custos")({
  component: GerencialCustosPage,
});

function GerencialCustosPage() {
  return (
    <GerencialPlaceholder
      title="Custos"
      description="Custo estimado em R$ (fonte oficial) e visualização em US$ pela cotação atual da empresa — sem alterar regras de preço Meta."
      legacyTo="/campanhas/custos"
      legacyLabel="Abrir Custos atuais (temporário)"
    />
  );
}
