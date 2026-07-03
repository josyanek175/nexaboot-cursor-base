import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/campanhas")({
  component: CampanhasLayout,
});

function CampanhasLayout() {
  return <Outlet />;
}
