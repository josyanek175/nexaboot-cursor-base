import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/relatorios")({
  component: RelatoriosLayout,
});

function RelatoriosLayout() {
  return <Outlet />;
}
