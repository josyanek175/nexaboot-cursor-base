import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, FileStack, Loader2, Plus, Save } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  actingUserFromAuth,
  canAccessCampaignsModule,
  canConfigureCampaignCosts,
  canViewCampaignCosts,
} from "@/lib/permissions";
import {
  normalizeAttendanceVariables,
  type AttendanceTemplateVariable,
} from "@/lib/attendance-template";

type MetaOpt = {
  id: string;
  template_name: string;
  language_code: string;
  category: string | null;
  channel_name: string | null;
  body_text: string | null;
};

type Preset = {
  id: string;
  name: string;
  description: string | null;
  meta_template_id: string;
  meta_template_name?: string;
  language_code?: string;
  variables: AttendanceTemplateVariable[];
  active: boolean;
  body_text?: string | null;
};

export const Route = createFileRoute("/_app/campanhas/templates-atendimento")({
  component: TemplatesAtendimentoPage,
});

function TemplatesAtendimentoPage() {
  const { user, companyValid, companyId, companyMessage } = useAuth();
  const actor = user
    ? actingUserFromAuth({ id: user.id, role: user.role as string, tenantId: user.tenantId })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };

  const canAccess =
    canAccessCampaignsModule(actor, companyValid) && canViewCampaignCosts(actor);
  const canEdit = canConfigureCampaignCosts(actor);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [metaTemplates, setMetaTemplates] = useState<MetaOpt[]>([]);

  const [metaTemplateId, setMetaTemplateId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [variablesJson, setVariablesJson] = useState("[]");
  const [active, setActive] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/attendance/templates?admin=1", {
        credentials: "include",
      });
      const j = (await res.json().catch(() => ({}))) as {
        templates?: Preset[];
        metaTemplates?: MetaOpt[];
        error?: string;
        message?: string;
      };
      if (!res.ok) throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      setPresets(j.templates ?? []);
      setMetaTemplates(j.metaTemplates ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canAccess) {
      setLoading(false);
      setError(
        companyMessage ?? "Apenas gerente ou admin pode gerenciar templates de atendimento.",
      );
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, companyId, canAccess]);

  function fillFromMeta(id: string) {
    setMetaTemplateId(id);
    const m = metaTemplates.find((x) => x.id === id);
    if (!m) return;
    if (!name.trim()) setName(m.template_name.replace(/_/g, " "));
    const body = m.body_text ?? "";
    const positions = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((x) => Number(x[1]));
    const uniq = [...new Set(positions)].sort((a, b) => a - b);
    const vars: AttendanceTemplateVariable[] = uniq.map((position) => ({
      position,
      label: position === 1 ? "Nome do cliente" : `Variável ${position}`,
      type: "text",
      source: position === 1 ? "customer_name" : "manual",
      required: true,
    }));
    setVariablesJson(JSON.stringify(vars, null, 2));
  }

  function startEdit(p: Preset) {
    setEditId(p.id);
    setMetaTemplateId(p.meta_template_id);
    setName(p.name);
    setDescription(p.description ?? "");
    setVariablesJson(JSON.stringify(p.variables ?? [], null, 2));
    setActive(p.active);
  }

  function resetForm() {
    setEditId(null);
    setMetaTemplateId("");
    setName("");
    setDescription("");
    setVariablesJson("[]");
    setActive(true);
  }

  async function save() {
    if (!canEdit) return;
    let variables: unknown = [];
    try {
      variables = normalizeAttendanceVariables(JSON.parse(variablesJson || "[]"));
    } catch {
      toast.error("JSON de variáveis inválido");
      return;
    }
    if (!metaTemplateId || !name.trim()) {
      toast.error("Selecione o template Meta e informe o nome amigável");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/attendance/templates", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editId,
          metaTemplateId,
          name: name.trim(),
          description: description.trim() || null,
          variables,
          active,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      toast.success(editId ? "Preset atualizado" : "Preset criado");
      resetForm();
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!canAccess) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {error ?? "Sem permissão."}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <FileStack className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">Templates atendimento</h1>
            <p className="text-xs text-muted-foreground">
              Vincule templates Meta APPROVED a nomes amigáveis e variáveis para o chat
            </p>
          </div>
        </div>
        <Link
          to="/campanhas"
          className="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent"
        >
          <ArrowLeft className="h-4 w-4" /> Voltar
        </Link>
      </header>

      <div className="flex-1 space-y-6 overflow-auto p-6">
        {canEdit && (
          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Plus className="h-4 w-4" />
              {editId ? "Editar preset" : "Novo preset"}
            </div>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Template Meta (sincronizado)</span>
              <select
                value={metaTemplateId}
                onChange={(e) => fillFromMeta(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Selecione…</option>
                {metaTemplates.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.template_name} ({m.language_code})
                    {m.channel_name ? ` · ${m.channel_name}` : ""}
                    {m.category ? ` · ${m.category}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Nome amigável</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Descrição</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Variables (JSON)</span>
              <textarea
                rows={8}
                value={variablesJson}
                onChange={(e) => setVariablesJson(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Ativo no atendimento
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={save}
                className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Salvar
              </button>
              {editId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded-md border border-input px-3 py-2 text-sm"
                >
                  Cancelar edição
                </button>
              )}
            </div>
          </section>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left">Nome</th>
                  <th className="px-4 py-3 text-left">Meta</th>
                  <th className="px-4 py-3 text-left">Ativo</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {presets.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                      Nenhum preset. Sincronize templates Meta e vincule aqui.
                    </td>
                  </tr>
                ) : (
                  presets.map((p) => (
                    <tr key={p.id} className="border-t border-border">
                      <td className="px-4 py-3">
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-muted-foreground">{p.description}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {p.meta_template_name} · {p.language_code}
                      </td>
                      <td className="px-4 py-3">{p.active ? "Sim" : "Não"}</td>
                      <td className="px-4 py-3 text-right">
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => startEdit(p)}
                            className="text-xs text-whatsapp hover:underline"
                          >
                            Editar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
