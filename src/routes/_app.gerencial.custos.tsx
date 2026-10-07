import { createFileRoute } from "@tanstack/react-router";
import { CustosTab } from "@/components/gerencial/custos-tab";

export const Route = createFileRoute("/_app/gerencial/custos")({
  component: GerencialCustosPage,
});

function GerencialCustosPage() {
  return <CustosTab />;
}
