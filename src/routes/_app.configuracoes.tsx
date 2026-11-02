import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { OperationsProblemPanel } from "@/components/operations-problem-panel";
import {
  useOperationsData,
  readOperationsResponse,
  asOperationsProblem,
  type OperationsProblem,
} from "@/lib/operations-client";
import { isPlatformRole } from "@/lib/platform-roles";

export const Route = createFileRoute("/_app/configuracoes")({
  component: Settings,
});

function Settings() {
  const { user, companyValid, companyName, companyId } = useAuth();
  const allowed = isPlatformRole(user?.role) || user?.role === "ADMIN_EMPRESA";
  type SettingsValue = {
    waiting_attendant_minutes: number;
    waiting_customer_hours: number;
    restrict_channels: boolean;
  };
  const resource = useOperationsData<SettingsValue>(
    "/api/company-operations",
    companyId,
    allowed && companyValid,
  );
  const [draft, setDraft] = useState<{ companyId: string | null; value: SettingsValue } | null>(
    null,
  );
  const value =
    draft && draft.companyId === companyId
      ? draft.value
      : (resource.data ?? {
          waiting_attendant_minutes: 10,
          waiting_customer_hours: 24,
          restrict_channels: false,
        });
  const setValue = (next: SettingsValue) => setDraft({ companyId, value: next });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationProblem, setMutationProblem] = useState<OperationsProblem | null>(null);
  if (!allowed)
    return <div className="p-6">Apenas o administrador pode alterar estas configurações.</div>;
  if (!companyValid) return <div className="p-6">Selecione uma empresa para configurar.</div>;
  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="text-xl font-semibold">Configurações de {companyName}</h1>
      <OperationsProblemPanel
        problem={mutationProblem ?? resource.problem}
        disabled={busy || resource.loading}
        onRetry={() => {
          setMutationProblem(null);
          resource.reload();
        }}
      />
      {resource.loading && (
        <p role="status" className="mt-4 text-sm">
          Carregando configurações…
        </p>
      )}
      <form
        className="mt-6 max-w-xl space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!resource.data || busy) return;
          setBusy(true);
          setMutationProblem(null);
          setMessage("");
          try {
            const r = await fetch("/api/company-operations", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(value),
            });
            await readOperationsResponse(r);
            setDraft(null);
            resource.reload();
            setMessage("Configurações salvas.");
          } catch (error) {
            setMutationProblem(asOperationsProblem(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy || !resource.data} className="space-y-5 disabled:opacity-50">
          <label className="block">
            Alerta aguardando atendente (minutos)
            <input
              className="mt-1 block rounded border p-2"
              type="number"
              required
              min={1}
              max={1440}
              value={value.waiting_attendant_minutes}
              onChange={(e) =>
                setValue({ ...value, waiting_attendant_minutes: Number(e.target.value) })
              }
            />
          </label>
          <label className="block">
            Alerta aguardando cliente (horas)
            <input
              className="mt-1 block rounded border p-2"
              type="number"
              required
              min={1}
              max={720}
              value={value.waiting_customer_hours}
              onChange={(e) =>
                setValue({ ...value, waiting_customer_hours: Number(e.target.value) })
              }
            />
          </label>
          <p className="text-sm text-muted-foreground">
            Estes prazos geram alertas. Conversas humanas não serão encerradas automaticamente.
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.restrict_channels}
              onChange={(e) => setValue({ ...value, restrict_channels: e.target.checked })}
            />
            Exigir liberação de números por usuário ou equipe
          </label>
          <p className="text-sm text-muted-foreground">
            Cadastre as liberações em Equipes e números antes de ativar. Administradores da empresa
            e suporte da plataforma mantêm acesso.
          </p>
          <button
            disabled={busy || !resource.data}
            className="rounded bg-emerald-700 px-4 py-2 text-white disabled:opacity-40"
          >
            {busy ? "Salvando…" : "Salvar"}
          </button>
        </fieldset>
        <p role="status">{message}</p>
      </form>
    </div>
  );
}
