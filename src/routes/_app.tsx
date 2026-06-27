import { createFileRoute, Navigate } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_app")({
  component: GuardedApp,
});

function GuardedApp() {
  const { isAuthenticated, hydrated } = useAuth();

  // Aguarda hidratação do localStorage para evitar redirect indevido na primeira renderização.
  if (!hydrated) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
        Carregando…
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  return <AppShell />;
}
