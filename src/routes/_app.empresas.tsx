import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2, Plus, Pencil, Power, ShieldAlert, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { type Tenant } from "@/lib/mocks";
import { useAuth } from "@/lib/auth";
import { canCreateTenant, canSuspendTenant } from "@/lib/permissions";
import { pushAudit } from "@/lib/audit-log";

type DbCompany = {
  id: string;
  name: string;
  slug: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

function dbToTenant(c: DbCompany): Tenant {
  return {
    id: c.id,
    name: c.name,
    cnpj: c.slug ?? "—",
    plan: "Free",
    status: c.active ? "ativo" : "suspenso",
    sharedAttendance: false,
  };
}

export const Route = createFileRoute("/_app/empresas")({
  component: EmpresasPage,
});

function EmpresasPage() {
  const { user, platformAccess, companyId } = useAuth();
  const actor = {
    id: user?.id ?? "",
    role: user?.role ?? "ATENDENTE",
    tenantId: user?.tenantId ?? "",
  };

  const [items, setItems] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const isPlatformView = platformAccess;

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/companies", { credentials: "include" });
      if (res.status === 401) {
        setError("Faça login novamente.");
        setItems([]);
        return;
      }
      if (res.status === 403) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        setError(j.message ?? "Sem permissão para listar empresas.");
        setItems([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { companies: DbCompany[] };
      setItems((data.companies ?? []).map(dbToTenant));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  const visible = isPlatformView
    ? items
    : items.filter((t) => t.id === companyId);

  function canEditCompany(t: Tenant): boolean {
    if (isPlatformView) return true;
    return actor.role === "ADMIN_EMPRESA" && companyId === t.id;
  }

  function openNew() {
    if (!canCreateTenant(actor)) {
      toast.error("Sem permissão para criar empresas");
      pushAudit({
        tenantId: actor.tenantId, actorId: actor.id, actorName: user?.name ?? "",
        action: "permission.denied", result: "denied", reason: "tenant.create",
      });
      return;
    }
    setEditing({ id: "", name: "", cnpj: "", plan: "Free", status: "ativo", sharedAttendance: false });
    setOpen(true);
  }

  function openEdit(t: Tenant) {
    if (!canEditCompany(t)) {
      toast.error("Sem permissão para editar esta empresa");
      pushAudit({
        tenantId: t.id, actorId: actor.id, actorName: user?.name ?? "", targetType: "tenant",
        targetId: t.id, targetName: t.name, action: "access.denied", result: "denied",
      });
      return;
    }
    setEditing({ ...t });
    setOpen(true);
  }

  async function save() {
    if (!editing || saving) return;
    setSaving(true);
    try {
      const exists = items.some((t) => t.id === editing.id);
      if (exists) {
        const res = await fetch(`/api/companies/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: editing.name,
            ...(isPlatformView ? {
              slug: editing.cnpj && editing.cnpj !== "—" ? editing.cnpj : null,
              active: editing.status === "ativo",
            } : {}),
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
      } else {
        const res = await fetch("/api/companies", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: editing.name,
            slug: editing.cnpj || null,
            active: editing.status === "ativo",
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
      }
      pushAudit({
        tenantId: editing.id || actor.tenantId, actorId: actor.id, actorName: user?.name ?? "",
        targetType: "tenant", targetId: editing.id, targetName: editing.name,
        action: exists ? "tenant.update" : "tenant.create", result: "success",
      });
      toast.success(exists ? "Empresa atualizada" : "Empresa criada");
      setOpen(false);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(t: Tenant) {
    if (!canSuspendTenant(actor)) {
      toast.error("Apenas ADMIN_GERAL pode suspender empresas");
      pushAudit({
        tenantId: t.id, actorId: actor.id, actorName: user?.name ?? "", targetType: "tenant",
        targetId: t.id, targetName: t.name, action: "permission.denied", result: "denied",
      });
      return;
    }
    const nextActive = t.status !== "ativo";
    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: nextActive }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next: Tenant["status"] = nextActive ? "ativo" : "suspenso";
      pushAudit({
        tenantId: t.id, actorId: actor.id, actorName: user?.name ?? "", targetType: "tenant",
        targetId: t.id, targetName: t.name, action: "tenant.toggle_status", result: "success",
        reason: `→ ${next}`,
      });
      toast.success(`Empresa ${t.name} agora está ${next}`);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Empresas / Tenants</h1>
            <p className="text-xs text-muted-foreground">
              {isPlatformView
                ? "Visão global · plataforma (public.companies)"
                : `Visão restrita à sua empresa (${companyId ?? "—"})`}
            </p>
          </div>
        </div>
        {canCreateTenant(actor) && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Nova empresa
          </button>
        )}
      </header>

      {!isPlatformView && (
        <div className="flex items-center gap-2 border-b border-border bg-amber-50 px-6 py-2 text-xs text-amber-800">
          <ShieldAlert className="h-3.5 w-3.5" /> Isolamento ativo: você só visualiza dados da empresa em que está logado.
        </div>
      )}

      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando empresas…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left">Nome</th>
                  <th className="px-4 py-3 text-left">Slug</th>
                  <th className="px-4 py-3 text-left">Plano</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Atendimento compartilhado</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      Nenhuma empresa encontrada no banco.
                    </td>
                  </tr>
                ) : visible.map((t) => {
                  const editable = canEditCompany(t);
                  const suspendable = canSuspendTenant(actor);
                  return (
                    <tr key={t.id} className="border-t border-border hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">{t.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{t.cnpj}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-md bg-accent px-2 py-1 text-xs">{t.plan}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 text-xs ${t.status === "ativo" ? "text-whatsapp" : "text-destructive"}`}>
                          <span className={`h-2 w-2 rounded-full ${t.status === "ativo" ? "bg-whatsapp" : "bg-destructive"}`} />
                          {t.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {t.sharedAttendance
                          ? <span className="rounded bg-whatsapp/10 px-2 py-1 font-medium text-whatsapp">Sim · todos veem a fila</span>
                          : <span className="rounded bg-muted px-2 py-1 text-muted-foreground">Não · apenas atribuídas + fila sem dono</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            disabled={!editable}
                            onClick={() => openEdit(t)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                            title={editable ? "Editar" : "Sem permissão"}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            disabled={!suspendable}
                            onClick={() => toggleStatus(t)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                            title={suspendable ? "Ativar/Suspender" : "Apenas ADMIN_GERAL"}
                          >
                            <Power className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-lg font-semibold">
              {items.some((t) => t.id === editing.id) ? "Editar empresa" : "Nova empresa"}
            </h2>
            <div className="space-y-3">
              <Field label="Nome" value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} />
              {isPlatformView && (
                <Field label="Slug" value={editing.cnpj === "—" ? "" : editing.cnpj} onChange={(v) => setEditing({ ...editing, cnpj: v })} />
              )}
              {isPlatformView && (
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    label="Status"
                    value={editing.status}
                    options={["ativo", "suspenso"]}
                    onChange={(v) => setEditing({ ...editing, status: v as Tenant["status"] })}
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Plano e atendimento compartilhado ainda não estão no banco (public.companies).
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="rounded-md px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
              <button
                onClick={save}
                disabled={saving}
                className="rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
              >
                {saving ? "Salvando…" : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
      />
    </label>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
      >
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}
