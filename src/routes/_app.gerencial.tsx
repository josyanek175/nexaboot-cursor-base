import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { actingUserFromAuth, canViewCampaignCosts } from "@/lib/permissions";
import { GerencialLayout } from "@/components/gerencial/gerencial-layout";

export const Route = createFileRoute("/_app/gerencial")({
  component: GerencialShell,
});

function GerencialShell() {
  const { user, companyValid, companyMessage } = useAuth();
  const actor = user
    ? actingUserFromAuth({
        id: user.id,
        role: user.role as string,
        tenantId: user.tenantId,
      })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };

  const canAccess = companyValid && canViewCampaignCosts(actor);

  if (!canAccess) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          {companyMessage ??
            (companyValid
              ? "Apenas gerente ou admin pode acessar Gerencial."
              : "Selecione uma empresa ativa.")}
        </p>
      </div>
    );
  }

  return (
    <GerencialLayout>
      <Outlet />
    </GerencialLayout>
  );
}
