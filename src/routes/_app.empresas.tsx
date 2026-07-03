import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2, Plus, Pencil, Power, ShieldAlert, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { canCreateTenant, canSuspendTenant, isPlatformRole } from "@/lib/permissions";
import { pushAudit } from "@/lib/audit-log";

type CompanyRow = {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  plan_name: string | null;
  plan_code: string | null;
  max_whatsapp_channels: number | null;
  subscription_status: string | null;
  subscription_ends_at: string | null;
  whatsapp_channels_used: number;
};

type PlanOption = {
  id: string;
  code: string;
  name: string;
  max_whatsapp_channels: number;
};

type EditDraft = {
  id: string;
  name: string;
  active: boolean;
};

type CreateDraft = {
  name: string;
  active: boolean;
  plan_id: string;
  admin_name: string;
  admin_email: string;
  admin_password: string;
};

function formatChannelUsage(row: CompanyRow): string {
  const used = row.whatsapp_channels_used ?? 0;
  if (row.max_whatsapp_channels != null) {
    return `${used} / ${row.max_whatsapp_channels}`;
  }
  return `${used} / —`;
}

export const Route = createFileRoute("/_app/empresas")({
  component: EmpresasPage,
});

function EmpresasPage() {
  const { user, companyId, companyName, hydrated } = useAuth();
  const actor = {
    id: user?.id ?? "",
    role: user?.role ?? "ATENDENTE",
    tenantId: user?.tenantId ?? "",
  };

  const [items, setItems] = useState<CompanyRow[]>([]);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [creating, setCreating] = useState<CreateDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const isPlatformView = user ? isPlatformRole(user.role) : false;

  async function loadPlans() {
    if (!isPlatformView) return;
    try {
      const res = await fetch("/api/plans", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { plans: PlanOption[] };
      setPlans(data.plans ?? []);
    } catch {
      /* ignore */
    }
  }

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
        const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        setError(
          j.message ??
            (j.error === "company_not_found"
              ? "Empresa vinculada à sua conta não foi encontrada."
              : "Sem permissão para listar empresas."),
        );
        setItems([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { companies: CompanyRow[] };
      setItems(data.companies ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!hydrated) return;
    reload();
    loadPlans();
  }, [hydrated, companyId]);

  const companySubtitle = companyName ?? companyId ?? "—";

  const visible = items;

  function canEditCompany(t: CompanyRow): boolean {
    if (isPlatformView) return true;
    return actor.role === "ADMIN_EMPRESA" && companyId === t.id;
  }

  async function openNew() {
    if (!canCreateTenant(actor)) {
      toast.error("Sem permissão para criar empresas");
      pushAudit({
        tenantId: actor.tenantId, actorId: actor.id, actorName: user?.name ?? "",
        action: "permission.denied", result: "denied", reason: "tenant.create",
      });
      return;
    }
    let planList = plans;
    if (planList.length === 0) {
      try {
        const res = await fetch("/api/plans", { credentials: "include" });
        if (res.ok) {
          const data = (await res.json()) as { plans: PlanOption[] };
          planList = data.plans ?? [];
          setPlans(planList);
        }
      } catch {
        /* ignore */
      }
    }
    setCreating({
      name: "",
      active: true,
      plan_id: planList[0]?.id ?? "",
      admin_name: "",
      admin_email: "",
      admin_password: "",
    });
  }

  function openEdit(t: CompanyRow) {
    if (!canEditCompany(t)) {
      toast.error("Sem permissão para editar esta empresa");
      pushAudit({
        tenantId: t.id, actorId: actor.id, actorName: user?.name ?? "", targetType: "tenant",
        targetId: t.id, targetName: t.name, action: "access.denied", result: "denied",
      });
      return;
    }
    setEditing({ id: t.id, name: t.name, active: t.active });
  }

  async function saveEdit() {
    if (!editing || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(editing.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editing.name,
          ...(isPlatformView ? { active: editing.active } : {}),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      pushAudit({
        tenantId: editing.id, actorId: actor.id, actorName: user?.name ?? "",
        targetType: "tenant", targetId: editing.id, targetName: editing.name,
        action: "tenant.update", result: "success",
      });
      toast.success("Empresa atualizada");
      setEditing(null);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveCreate() {
    if (!creating || saving) return;
    if (!creating.plan_id) {
      toast.error("Selecione um plano");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: creating.name,
          active: creating.active,
          plan_id: creating.plan_id,
          admin: {
            name: creating.admin_name,
            email: creating.admin_email,
            password: creating.admin_password,
          },
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; detail?: unknown };
        const msg =
          j.error === "email_already_exists"
            ? "E-mail do administrador já está em uso."
            : j.error === "plan_not_found"
              ? "Plano inválido."
              : j.error ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      pushAudit({
        tenantId: actor.tenantId, actorId: actor.id, actorName: user?.name ?? "",
        targetType: "tenant", targetName: creating.name,
        action: "tenant.create", result: "success",
      });
      toast.success("Empresa criada com plano e administrador");
      setCreating(null);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(t: CompanyRow) {
    if (!canSuspendTenant(actor)) {
      toast.error("Apenas perfil de plataforma pode suspender empresas");
      pushAudit({
        tenantId: t.id, actorId: actor.id, actorName: user?.name ?? "", targetType: "tenant",
        targetId: t.id, targetName: t.name, action: "permission.denied", result: "denied",
      });
      return;
    }
    const nextActive = !t.active;
    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: nextActive }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const label = nextActive ? "ativo" : "inativo";
      pushAudit({
        tenantId: t.id, actorId: actor.id, actorName: user?.name ?? "", targetType: "tenant",
        targetId: t.id, targetName: t.name, action: "tenant.toggle_status", result: "success",
        reason: `→ ${label}`,
      });
      toast.success(`Empresa ${t.name} agora está ${label}`);
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
                ? "Visão global · plano e uso de canais"
                : `Sua empresa · plano e consumo (${companySubtitle})`}
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
          <ShieldAlert className="h-3.5 w-3.5" /> Você visualiza apenas o plano e o consumo da sua empresa.
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
                  <th className="px-4 py-3 text-left">Plano</th>
                  <th className="px-4 py-3 text-left">Canais WhatsApp</th>
                  <th className="px-4 py-3 text-left">Assinatura</th>
                  <th className="px-4 py-3 text-left">Status</th>
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
                  const atLimit =
                    t.max_whatsapp_channels != null &&
                    t.whatsapp_channels_used >= t.max_whatsapp_channels;
                  return (
                    <tr key={t.id} className="border-t border-border hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">{t.name}</td>
                      <td className="px-4 py-3">
                        {t.plan_name ? (
                          <span className="rounded-md bg-accent px-2 py-1 text-xs">{t.plan_name}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Sem plano</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`text-xs font-medium ${atLimit ? "text-amber-700" : "text-foreground"}`}
                        >
                          {formatChannelUsage(t)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {t.subscription_status ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 text-xs ${t.active ? "text-whatsapp" : "text-destructive"}`}>
                          <span className={`h-2 w-2 rounded-full ${t.active ? "bg-whatsapp" : "bg-destructive"}`} />
                          {t.active ? "ativa" : "inativa"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            disabled={!editable}
                            onClick={() => openEdit(t)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-30"
                            title={editable ? "Editar" : "Sem permissão"}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            disabled={!suspendable}
                            onClick={() => toggleStatus(t)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-30"
                            title={suspendable ? "Ativar/Inativar" : "Apenas plataforma"}
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

      {editing && (
        <Modal title="Editar empresa" onClose={() => setEditing(null)}>
          <Field label="Nome" value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} />
          {isPlatformView && (
            <Select
              label="Status"
              value={editing.active ? "ativa" : "inativa"}
              options={["ativa", "inativa"]}
              onChange={(v) => setEditing({ ...editing, active: v === "ativa" })}
            />
          )}
          <ModalActions
            saving={saving}
            onCancel={() => setEditing(null)}
            onSave={saveEdit}
            saveLabel="Salvar"
          />
        </Modal>
      )}

      {creating && (
        <Modal title="Nova empresa" onClose={() => setCreating(null)}>
          <Field label="Nome da empresa" value={creating.name} onChange={(v) => setCreating({ ...creating, name: v })} />
          <Select
            label="Status"
            value={creating.active ? "ativa" : "inativa"}
            options={["ativa", "inativa"]}
            onChange={(v) => setCreating({ ...creating, active: v === "ativa" })}
          />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Plano contratado</span>
            <select
              value={creating.plan_id}
              onChange={(e) => setCreating({ ...creating, plan_id: e.target.value })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
            >
              {plans.length === 0 ? (
                <option value="">Carregando planos…</option>
              ) : (
                plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (até {p.max_whatsapp_channels} WhatsApp)
                  </option>
                ))
              )}
            </select>
          </label>
          <p className="text-xs font-medium text-muted-foreground pt-2">Administrador da empresa (ADMIN_EMPRESA)</p>
          <Field label="Nome" value={creating.admin_name} onChange={(v) => setCreating({ ...creating, admin_name: v })} />
          <Field label="E-mail" value={creating.admin_email} onChange={(v) => setCreating({ ...creating, admin_email: v })} />
          <Field label="Senha inicial" type="password" value={creating.admin_password} onChange={(v) => setCreating({ ...creating, admin_password: v })} />
          <ModalActions
            saving={saving}
            onCancel={() => setCreating(null)}
            onSave={saveCreate}
            saveLabel="Criar empresa"
          />
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        <div className="space-y-3">{children}</div>
      </div>
    </div>
  );
}

function ModalActions({ saving, onCancel, onSave, saveLabel }: { saving: boolean; onCancel: () => void; onSave: () => void; saveLabel: string }) {
  return (
    <div className="mt-6 flex justify-end gap-2">
      <button type="button" onClick={onCancel} className="rounded-md px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
      >
        {saving ? "Salvando…" : saveLabel}
      </button>
    </div>
  );
}

function Field({
  label, value, onChange, type = "text",
}: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type={type}
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
