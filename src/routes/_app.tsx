import { createFileRoute, Navigate } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_app")({
  component: GuardedApp,
});

function GuardedApp() {
  const { isAuthenticated, hydrated, companyValid, companyMessage, logout } = useAuth();

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

  // Isolamento oficial por company_id: sem empresa válida, bloqueia TODOS os
  // módulos operacionais. O usuário pode apenas sair e contatar o administrador.
  if (!companyValid) {
    return (
      <div className="grid min-h-screen place-items-center bg-background p-6">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">Acesso bloqueado</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {companyMessage ??
              "Seu usuário não está vinculado a uma empresa. Contate o administrador."}
          </p>
          <button
            type="button"
            onClick={logout}
            className="mt-5 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Sair
          </button>
        </div>
      </div>
    );
  }

  return <AppShell />;
}
