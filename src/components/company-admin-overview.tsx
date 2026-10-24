import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";

type Company = {
  id: string;
  name: string;
  active: boolean;
  plan_name: string | null;
  active_users: number;
  max_users: number | null;
  whatsapp_channels_used: number;
};
type Plan = { id: string; name: string; max_users: number | null; max_whatsapp_channels: number };

export function CompanyAdminOverview({
  companies,
  plans,
  platform,
  reload,
}: {
  companies: Company[];
  plans: Plan[];
  platform: boolean;
  reload: () => Promise<void>;
}) {
  const { setOperationalCompany, user } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Company | null>(null);
  const [planId, setPlanId] = useState("");
  const [busy, setBusy] = useState(false);
  async function employees(company: Company) {
    setBusy(true);
    try {
      if (platform) await setOperationalCompany(company.id);
      await navigate({ to: "/usuarios" });
    } catch {
      toast.error("Não foi possível selecionar a empresa.");
    } finally {
      setBusy(false);
    }
  }
  async function savePlan() {
    if (!selected || !planId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/companies/${selected.id}/subscription`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: planId }),
      });
      if (!res.ok) throw new Error("Não foi possível alterar o plano.");
      toast.success("Plano atualizado");
      setSelected(null);
      await reload();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mb-8 space-y-4" aria-label="Visão administrativa">
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ["Empresas ativas", companies.filter((c) => c.active).length],
          ["Funcionários ativos", companies.reduce((n, c) => n + (c.active_users ?? 0), 0)],
          ["Números cadastrados", companies.reduce((n, c) => n + c.whatsapp_channels_used, 0)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <label className="flex-1 text-sm">
          Buscar empresa
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2"
            placeholder="Nome da empresa"
          />
        </label>
        <button
          disabled={busy}
          onClick={reload}
          className="mt-5 rounded-md border border-border px-3 py-2 text-sm"
        >
          Atualizar
        </button>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {companies
          .filter((c) =>
            c.name.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR")),
          )
          .map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">
                  {c.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    {c.active ? "Ativa" : "Inativa"}
                  </span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {c.plan_name ?? "Sem plano"} · {c.active_users ?? 0} /{" "}
                  {c.max_users ?? "Sem limite"} funcionários ativos
                </p>
              </div>
              <div className="flex gap-2">
                {(platform || user?.role === "ADMIN_EMPRESA") && (
                  <button
                    disabled={busy || !c.active}
                    onClick={() => employees(c)}
                    className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40"
                  >
                    Funcionários
                  </button>
                )}
                {platform && (
                  <button
                    disabled={busy || plans.length === 0}
                    onClick={() => {
                      setSelected(c);
                      setPlanId("");
                    }}
                    className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40"
                  >
                    Alterar plano
                  </button>
                )}
              </div>
            </div>
          ))}
        {companies.filter((c) =>
          c.name.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR")),
        ).length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">Nenhuma empresa encontrada.</p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Os limites exibidos são os do plano. A aplicação automática dos limites, os endereços por
        empresa e a recuperação por e-mail fazem parte das próximas entregas.
      </p>
      {selected && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="plan-dialog-title"
            className="w-full max-w-md space-y-4 rounded-lg border border-border bg-card p-6"
          >
            <h2 id="plan-dialog-title" className="text-lg font-semibold">
              Plano de {selected.name}
            </h2>
            <p className="text-sm text-muted-foreground">
              Plano atual: {selected.plan_name ?? "Sem plano"}. A alteração preserva funcionários,
              números e histórico.
            </p>
            <label className="block text-sm">
              Novo plano
              <select
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                className="mt-2 w-full rounded-md border border-input bg-background p-2"
              >
                <option value="">Selecione</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.max_users ?? "Ilimitados"} usuários · {p.max_whatsapp_channels}{" "}
                    números
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <button
                disabled={busy}
                onClick={() => setSelected(null)}
                className="rounded-md border border-border px-3 py-2"
              >
                Cancelar
              </button>
              <button
                disabled={busy || !planId}
                onClick={savePlan}
                className="rounded-md bg-whatsapp px-3 py-2 text-whatsapp-foreground disabled:opacity-40"
              >
                {busy ? "Salvando…" : "Confirmar plano"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
