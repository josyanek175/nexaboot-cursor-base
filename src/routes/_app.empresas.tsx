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
  slug: string | null;
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

type EditDraft = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
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
  const { user, companyId } = useAuth();
  const actor = {
    id: user?.id ?? "",
    role: user?.role ?? "ATENDENTE",
    tenantId: user?.tenantId ?? "",
  };

  const [items, setItems] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const isPlatformView = user ? isPlatformRole(user.role) : false;

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
    reload();
  }, []);

  // Escopo definido pelo backend — não refiltrar por company_id / sidebar no cliente.
  const visible = items;

  function canEditCompany(t: CompanyRow): boolean {
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
    setEditing({ id: "", name: "", slug: "", active: true });
    setOpen(true);
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
    setEditing({
      id: t.id,
      name: t.name,
      slug: t.slug ?? "",
      active: t.active,
    });
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
              slug: editing.slug || null,
              active: editing.active,
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
            slug: editing.slug || null,
            active: editing.active,
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

  async function toggleStatus(t: CompanyRow) {
    if (!canSuspendTenant(actor)) {
      toast.error("Apenas ADMIN_GERAL pode suspender empresas");
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
      const label = nextActive ? "ativo" : "suspenso";
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
                ? "Visão global · plano e uso de canais (public.companies)"
                : `Sua empresa · plano e consumo (${companyId ?? "—"})`}
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
          <ShieldAlert className="h-3.5 w-3.5" /> Você visualiza apenas o plano e o consumo da sua empresa. Alteração de plano é feita pela equipe NexaBoot.
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
                  <th className="px-4 py-3 text-left">Canais WhatsApp</th>
                  <th className="px-4 py-3 text-left">Assinatura</th>
                  <th className="px-4 py-3 text-left">Empresa</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
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
                      <td className="px-4 py-3 text-muted-foreground">{t.slug ?? "—"}</td>
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
                          title={atLimit ? "Limite do plano atingido (bloqueio na fase 2)" : undefined}
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
                          {t.active ? "ativo" : "suspenso"}
                        </span>
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
                <Field label="Slug" value={editing.slug} onChange={(v) => setEditing({ ...editing, slug: v })} />
              )}
              {isPlatformView && (
                <Select
                  label="Status da empresa"
                  value={editing.active ? "ativo" : "suspenso"}
                  options={["ativo", "suspenso"]}
                  onChange={(v) => setEditing({ ...editing, active: v === "ativo" })}
                />
              )}
              <p className="text-xs text-muted-foreground">
                Plano e assinatura serão vinculados na próxima fase (onboarding comercial).
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
