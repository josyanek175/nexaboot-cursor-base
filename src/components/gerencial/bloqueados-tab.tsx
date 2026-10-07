import { useEffect, useState } from "react";
import { Download, Loader2, Lock, Save } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  actingUserFromAuth,
  canConfigureCampaignDispatchWindow,
} from "@/lib/permissions";
import { DISPATCH_WINDOW_LABEL } from "@/lib/campaign-dispatch-window";
import {
  formatGerencialDt,
  gerencialFetchJson,
} from "@/lib/gerencial-fetch";
import { buildGerencialCsv, downloadGerencialCsv } from "@/lib/gerencial-csv";

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

export function BloqueadosTab() {
  const { user, companyId } = useAuth();
  const actor = user
    ? actingUserFromAuth({
        id: user.id,
        role: user.role as string,
        tenantId: user.tenantId,
      })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };
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
      const data = await gerencialFetchJson<{
        blocked: BlockedRow[];
        settings: Settings;
      }>("/api/campaigns/dispatch-blocks");
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
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, user?.id]);

  async function saveSettings() {
    if (!canConfigure) return;
    setSaving(true);
    try {
      const data = await gerencialFetchJson<{ settings: Settings }>(
        "/api/campaigns/dispatch-window",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        },
      );
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

  function exportCsv() {
    const csv = buildGerencialCsv(blocked, [
      { header: "Contato", value: (r) => r.name ?? "" },
      { header: "Telefone", value: (r) => r.phone },
      { header: "Disparos", value: (r) => r.sendCount },
      { header: "Janela (dias)", value: (r) => r.windowDays },
      { header: "Último disparo", value: (r) => r.lastSentAt },
      { header: "Libera em", value: (r) => r.liberatesAt },
      { header: "Última campanha", value: (r) => r.lastCampaignName ?? "" },
    ]);
    const day = new Date().toISOString().slice(0, 10);
    downloadGerencialCsv(`gerencial-bloqueados_${day}.csv`, csv);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Mesma regra da tela Campanhas → Bloqueados · lista em tempo real (não filtra
          pelo período das outras abas)
        </p>
        <button
          type="button"
          onClick={exportCsv}
          disabled={blocked.length === 0}
          className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" /> Exportar CSV
        </button>
      </div>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Configuração da janela</h2>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Após o 1º disparo: {settings.firstWindowDays} dias · 2º:{" "}
          {settings.secondWindowDays} dias · 3º em diante: {settings.thirdWindowDays}{" "}
          dias. Contatos liberados saem automaticamente desta lista.
        </p>
        {canConfigure ? (
          <div className="flex flex-wrap items-end gap-3">
            <DaysInput
              label="Após 1º disparo (dias)"
              value={draft.firstWindowDays}
              onChange={(v) => setDraft((d) => ({ ...d, firstWindowDays: v }))}
            />
            <DaysInput
              label="Após 2º disparo (dias)"
              value={draft.secondWindowDays}
              onChange={(v) => setDraft((d) => ({ ...d, secondWindowDays: v }))}
            />
            <DaysInput
              label="Após 3º+ disparo (dias)"
              value={draft.thirdWindowDays}
              onChange={(v) => setDraft((d) => ({ ...d, thirdWindowDays: v }))}
            />
            <button
              type="button"
              disabled={saving}
              onClick={() => void saveSettings()}
              className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
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
        <>
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Bloqueados agora</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {blocked.length}
            </div>
          </div>

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
                    <td
                      colSpan={7}
                      className="px-4 py-8 text-center text-muted-foreground"
                    >
                      Nenhum número em janela de disparo no momento.
                    </td>
                  </tr>
                ) : (
                  blocked.map((row) => (
                    <tr
                      key={row.phoneMatch ?? row.phone}
                      className="border-t border-border"
                    >
                      <td className="px-4 py-3">{row.name ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs">{row.phone}</td>
                      <td className="px-4 py-3">{row.sendCount}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                          {row.windowDays} dias · {DISPATCH_WINDOW_LABEL}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {formatGerencialDt(row.lastSentAt)}
                      </td>
                      <td className="px-4 py-3 text-xs font-medium">
                        {formatGerencialDt(row.liberatesAt)}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {row.lastCampaignName ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function DaysInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input
        type="number"
        min={1}
        max={365}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 1)}
        className="w-28 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      />
    </label>
  );
}
