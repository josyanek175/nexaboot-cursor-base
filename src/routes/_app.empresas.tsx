import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Building2, Plus, Pencil, Power, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { tenants as seed, type Tenant } from "@/lib/mocks";
import { useSession } from "@/lib/session";
import { canCreateTenant, canEditTenant, canSuspendTenant } from "@/lib/permissions";
import { pushAudit } from "@/lib/audit-log";

export const Route = createFileRoute("/_app/empresas")({
  component: EmpresasPage,
});

function EmpresasPage() {
  const { session, user, isSuperAdmin } = useSession();
  const actor = { id: session.userId, role: session.role, tenantId: session.tenantId };

  const [items, setItems] = useState<Tenant[]>(seed);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [open, setOpen] = useState(false);

  // Isolamento: ADMIN_EMPRESA só vê a própria empresa.
  const visible = isSuperAdmin ? items : items.filter((t) => t.id === user.tenantId);

  function openNew() {
    if (!canCreateTenant(actor)) {
      toast.error("Sem permissão para criar empresas");
      pushAudit({
        tenantId: actor.tenantId, actorId: actor.id, actorName: user.name,
        action: "permission.denied", result: "denied", reason: "tenant.create",
      });
      return;
    }
    setEditing({ id: `t-${Date.now()}`, name: "", cnpj: "", plan: "Free", status: "ativo", sharedAttendance: false });
    setOpen(true);
  }
  function openEdit(t: Tenant) {
    if (!canEditTenant(actor, t)) {
      toast.error("Sem permissão para editar esta empresa");
      pushAudit({
        tenantId: t.id, actorId: actor.id, actorName: user.name, targetType: "tenant",
        targetId: t.id, targetName: t.name, action: "access.denied", result: "denied",
      });
      return;
    }
    setEditing({ ...t });
    setOpen(true);
  }
  function save() {
    if (!editing) return;
    const exists = items.some((t) => t.id === editing.id);
    setItems((prev) => (exists ? prev.map((t) => (t.id === editing.id ? editing : t)) : [...prev, editing]));
    pushAudit({
      tenantId: editing.id, actorId: actor.id, actorName: user.name, targetType: "tenant",
      targetId: editing.id, targetName: editing.name,
      action: exists ? "tenant.update" : "tenant.create", result: "success",
    });
    toast.success(exists ? "Empresa atualizada" : "Empresa criada");
    setOpen(false);
  }
  function toggleStatus(t: Tenant) {
    if (!canSuspendTenant(actor)) {
      toast.error("Apenas ADMIN_GERAL pode suspender empresas");
      pushAudit({
        tenantId: t.id, actorId: actor.id, actorName: user.name, targetType: "tenant",
        targetId: t.id, targetName: t.name, action: "permission.denied", result: "denied",
      });
      return;
    }
    const next: Tenant["status"] = t.status === "ativo" ? "suspenso" : "ativo";
    setItems((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)));
    pushAudit({
      tenantId: t.id, actorId: actor.id, actorName: user.name, targetType: "tenant",
      targetId: t.id, targetName: t.name, action: "tenant.toggle_status", result: "success",
      reason: `→ ${next}`,
    });
    toast.success(`Empresa ${t.name} agora está ${next}`);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Empresas / Tenants</h1>
            <p className="text-xs text-muted-foreground">
              {isSuperAdmin ? "Visão global · ADMIN_GERAL" : `Visão restrita à sua empresa (${user.tenantId})`}
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

      {!isSuperAdmin && (
        <div className="flex items-center gap-2 border-b border-border bg-amber-50 px-6 py-2 text-xs text-amber-800">
          <ShieldAlert className="h-3.5 w-3.5" /> Isolamento ativo: você só visualiza dados da empresa em que está logado.
        </div>
      )}

      <div className="flex-1 overflow-auto p-6">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left">Nome</th>
                <th className="px-4 py-3 text-left">CNPJ</th>
                <th className="px-4 py-3 text-left">Plano</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Atendimento compartilhado</th>
                <th className="px-4 py-3 text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const editable = canEditTenant(actor, t);
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
      </div>

      {open && editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-lg font-semibold">
              {items.some((t) => t.id === editing.id) ? "Editar empresa" : "Nova empresa"}
            </h2>
            <div className="space-y-3">
              <Field label="Nome" value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} />
              <Field label="CNPJ" value={editing.cnpj} onChange={(v) => setEditing({ ...editing, cnpj: v })} />
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Plano"
                  value={editing.plan}
                  options={["Free", "Pro", "Business"]}
                  onChange={(v) => setEditing({ ...editing, plan: v as Tenant["plan"] })}
                />
                <Select
                  label="Status"
                  value={editing.status}
                  options={["ativo", "suspenso"]}
                  onChange={(v) => setEditing({ ...editing, status: v as Tenant["status"] })}
                />
              </div>
              <label className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={editing.sharedAttendance}
                  onChange={(e) => setEditing({ ...editing, sharedAttendance: e.target.checked })}
                />
                <span>
                  <span className="font-medium">Atendimento compartilhado</span>
                  <span className="block text-xs text-muted-foreground">
                    Quando ativo, todos os atendentes da empresa veem todas as conversas abertas/aguardando.
                    Quando desligado, cada atendente vê apenas as conversas atribuídas a ele + fila sem dono.
                  </span>
                </span>
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="rounded-md px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
              <button onClick={save} className="rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90">
                Salvar
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
