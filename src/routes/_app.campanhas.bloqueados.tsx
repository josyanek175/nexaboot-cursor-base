import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Loader2, Lock, Save, ShieldBan } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  actingUserFromAuth,
  canAccessCampaignsModule,
  canConfigureCampaignDispatchWindow,
} from "@/lib/permissions";
import { DISPATCH_WINDOW_LABEL } from "@/lib/campaign-dispatch-window";

type Settings = {
  firstWindowDays: number;
  secondWindowDays: number;
  thirdWindowDays: number;
};

type BlockedRow = {
  phone: string;
  phoneMatch: string;
  name: string | null;
  sendCount: number;
  windowDays: number;
  lastSentAt: string;
  liberatesAt: string;
  lastCampaignId: string | null;
  lastCampaignName: string | null;
};

export const Route = createFileRoute("/_app/campanhas/bloqueados")({
  component: CampanhasBloqueadosPage,
});

function formatDt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

function CampanhasBloqueadosPage() {
  const { user, companyValid, companyId, companyMessage } = useAuth();
  const actor = user
    ? actingUserFromAuth({ id: user.id, role: user.role as string, tenantId: user.tenantId })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };

  const canAccess = canAccessCampaignsModule(actor, companyValid);
  const canConfigure = canConfigureCampaignDispatchWindow(actor);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<BlockedRow[]>([]);
  const [settings, setSettings] = useState<Settings>({
    firstWindowDays: 7,
    secondWindowDays: 10,
    thirdWindowDays: 30,
  });
  const [draft, setDraft] = useState<Settings>(settings);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns/dispatch-blocks", { credentials: "include" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
          detail?: string | null;
        };
        const base = j.message ?? j.error ?? `HTTP ${res.status}`;
        throw new Error(j.detail ? `${base} (${j.detail})` : base);
      }
      const data = (await res.json()) as { blocked: BlockedRow[]; settings: Settings };
      setBlocked(data.blocked ?? []);
      const next = data.settings ?? settings;
      setSettings(next);
      setDraft(next);
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
        companyMessage ??
          (companyValid ? "Sem permissão para acessar Campanhas." : "Selecione uma empresa ativa."),
      );
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, companyId, companyValid, canAccess]);

  async function saveSettings() {
    if (!canConfigure) return;
    setSaving(true);
    try {
      const res = await fetch("/api/campaigns/dispatch-window", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { settings: Settings };
      setSettings(data.settings);
      setDraft(data.settings);
      toast.success("Janela de disparo atualizada");
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!canAccess) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Sem permissão para acessar Campanhas.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <ShieldBan className="h-5 w-5 text-amber-600" />
          <div>
            <h1 className="text-lg font-semibold">Bloqueados — janela de disparo</h1>
            <p className="text-xs text-muted-foreground">
              Números que receberam campanha e ainda estão na janela configurada pela empresa
            </p>
          </div>
        </div>
        <Link
          to="/campanhas"
          className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
        >
          <ArrowLeft className="h-4 w-4" /> Voltar
        </Link>
      </header>

      <div className="flex-1 space-y-6 overflow-auto p-6">
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Configuração da janela</h2>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            Após o 1º disparo: {settings.firstWindowDays} dias · 2º: {settings.secondWindowDays}{" "}
            dias · 3º em diante: {settings.thirdWindowDays} dias. Contatos liberados saem
            automaticamente desta lista.
          </p>
          {canConfigure ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs">
                <span className="mb-1 block text-muted-foreground">Após 1º disparo (dias)</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={draft.firstWindowDays}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, firstWindowDays: Number(e.target.value) || 1 }))
                  }
                  className="w-28 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-muted-foreground">Após 2º disparo (dias)</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={draft.secondWindowDays}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, secondWindowDays: Number(e.target.value) || 1 }))
                  }
                  className="w-28 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-muted-foreground">Após 3º+ disparo (dias)</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={draft.thirdWindowDays}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, thirdWindowDays: Number(e.target.value) || 1 }))
                  }
                  className="w-28 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <button
                type="button"
                disabled={saving}
                onClick={saveSettings}
                className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Salvar
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Somente gerente ou admin pode alterar estes prazos.
            </p>
          )}
        </section>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando bloqueados…
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
                  <th className="px-4 py-3 text-left">Contato</th>
                  <th className="px-4 py-3 text-left">Telefone</th>
                  <th className="px-4 py-3 text-left">Disparos</th>
                  <th className="px-4 py-3 text-left">Janela</th>
                  <th className="px-4 py-3 text-left">Último disparo</th>
                  <th className="px-4 py-3 text-left">Libera em</th>
                  <th className="px-4 py-3 text-left">Última campanha</th>
                </tr>
              </thead>
              <tbody>
                {blocked.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      Nenhum número em janela de disparo no momento.
                    </td>
                  </tr>
                ) : (
                  blocked.map((row) => (
                    <tr key={row.phoneMatch ?? row.phone} className="border-t border-border">
                      <td className="px-4 py-3">{row.name ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs">{row.phone}</td>
                      <td className="px-4 py-3">{row.sendCount}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                          {row.windowDays} dias · {DISPATCH_WINDOW_LABEL}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {formatDt(row.lastSentAt)}
                      </td>
                      <td className="px-4 py-3 text-xs font-medium">{formatDt(row.liberatesAt)}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {row.lastCampaignName ?? "—"}
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
