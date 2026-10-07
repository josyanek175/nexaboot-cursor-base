import { createFileRoute } from "@tanstack/react-router";
import { BloqueadosTab } from "@/components/gerencial/bloqueados-tab";

export const Route = createFileRoute("/_app/gerencial/bloqueados")({
  component: GerencialBloqueadosPage,
});

function GerencialBloqueadosPage() {
  return <BloqueadosTab />;
}
