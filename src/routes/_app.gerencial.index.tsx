import { createFileRoute } from "@tanstack/react-router";
import { VisaoGeral } from "@/components/gerencial/visao-geral";

export const Route = createFileRoute("/_app/gerencial/")({
  component: GerencialVisaoGeralPage,
});

function GerencialVisaoGeralPage() {
  return <VisaoGeral />;
}
