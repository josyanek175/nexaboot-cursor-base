import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Megaphone, Plus, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { canViewCampaigns, canManageCampaigns, canDeleteCampaign } from "@/lib/permissions";
import { apiDelete } from "@/lib/api";

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  total_contacts: number;
  skipped_count: number;
  channel_name: string | null;
  send_interval_ms: number;
  created_at: string;
  updated_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  running: "Em envio",
  paused: "Pausada",
  completed: "Concluída",
  canceled: "Cancelada",
  failed: "Falhou",
};

export const Route = createFileRoute("/_app/campanhas")({
  component: CampanhasPage,
});

function CampanhasPage() {
  const { user } = useAuth();
  const actor = {
    id: user?.id ?? "",
    role: user?.role ?? "ATENDENTE",
    tenantId: user?.tenantId ?? "",
  };

  const [items, setItems] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canView = canViewCampaigns(actor);
  const canManage = canManageCampaigns(actor);
  const canDelete = canDeleteCampaign(actor);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns", { credentials: "include" });
      if (res.status === 403) {
        setError("Sem permissão para acessar Campanhas.");
        setItems([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { campaigns: CampaignRow[] };
      setItems(data.campaigns ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const a = {
      id: user?.id ?? "",
      role: user?.role ?? "ATENDENTE",
      tenantId: user?.tenantId ?? "",
    };
    if (!canViewCampaigns(a)) {
      setLoading(false);
      setError("Sem permissão para acessar Campanhas.");
      return;
    }
    reload();
  }, [user?.id, user?.role, user?.tenantId]);

  async function handleDelete(id: string, name: string) {
    if (!canDelete) {
      toast.error("Sem permissão para excluir campanhas");
      return;
    }
    if (!confirm(`Excluir a campanha "${name}"?`)) return;
    try {
      await apiDelete(`/campaigns/${encodeURIComponent(id)}`);
      toast.success("Campanha excluída");
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!canView) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Sem permissão para acessar Campanhas.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <Megaphone className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Campanhas</h1>
            <p className="text-xs text-muted-foreground">
              Envio em massa via WhatsApp (Evolution) — rascunhos e público
            </p>
          </div>
        </div>
        {canManage && (
          <Link
            to="/campanhas/nova"
            className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Nova campanha
          </Link>
        )}
      </header>

      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando campanhas…
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
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Canal</th>
                  <th className="px-4 py-3 text-left">Público (total)</th>
                  <th className="px-4 py-3 text-left">Criada em</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      Nenhuma campanha encontrada.{" "}
                      {canManage && (
                        <Link to="/campanhas/nova" className="text-whatsapp underline">
                          Criar a primeira
                        </Link>
                      )}
                    </td>
                  </tr>
                ) : (
                  items.map((c) => (
                    <tr key={c.id} className="border-t border-border hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">{c.name}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-md bg-accent px-2 py-1 text-xs">
                          {STATUS_LABEL[c.status] ?? c.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{c.channel_name ?? "—"}</td>
                      <td className="px-4 py-3">
                        {c.total_contacts}
                        {c.skipped_count > 0 && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({c.skipped_count} ignorados)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {new Date(c.created_at).toLocaleString("pt-BR")}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          {canManage && (
                            <Link
                              to="/campanhas/$id"
                              params={{ id: c.id }}
                              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                              title="Editar"
                            >
                              <Pencil className="h-4 w-4" />
                            </Link>
                          )}
                          {canDelete && c.status === "draft" && (
                            <button
                              type="button"
                              onClick={() => handleDelete(c.id, c.name)}
                              className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              title="Excluir"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
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
