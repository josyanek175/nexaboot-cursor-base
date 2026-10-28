import type { FlowStatus } from "@/lib/automation-flow";

export function FlowToolbar({
  name,
  status,
  saving,
  onBack,
  onName,
  onStatus,
  onSave,
  onPublish,
  onTest,
  onSettings,
}: {
  name: string;
  status: FlowStatus;
  saving: boolean;
  onBack: () => void;
  onName: (name: string) => void;
  onStatus: (status: FlowStatus) => void;
  onSave: () => void;
  onPublish: () => void;
  onTest: () => void;
  onSettings: () => void;
}) {
  return (
    <header className="grid shrink-0 grid-cols-6 items-center gap-2 border-b border-border bg-card px-3 py-2 xl:flex xl:flex-wrap xl:gap-3 xl:px-4 xl:py-3">
      <button className="col-span-2 min-h-11 text-sm text-muted-foreground" onClick={onBack}>← Fluxos</button>
      <input
        value={name}
        onChange={(event) => onName(event.target.value)}
        placeholder="Nome do fluxo"
        aria-label="Nome do fluxo"
        className="col-span-4 min-h-11 min-w-0 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm font-medium xl:w-auto xl:min-w-48 xl:flex-1"
      />
      <select
        value={status}
        onChange={(event) => onStatus(event.target.value as FlowStatus)}
        aria-label="Status do fluxo"
        className="col-span-3 min-h-11 min-w-0 rounded-xl border border-input bg-background px-2 py-2 text-xs xl:px-3 xl:text-sm"
      >
        <option value="draft">Rascunho</option>
        <option value="active">Publicado</option>
        <option value="paused">Pausado</option>
      </select>
      <button className="col-span-3 min-h-11 rounded-full bg-muted px-2 py-2 text-xs xl:px-4 xl:text-sm" onClick={onSettings} aria-label="Configurações do fluxo"><span className="xl:hidden">Ajustes</span><span className="hidden xl:inline">Configurações</span></button>
      <button className="col-span-2 min-h-11 rounded-full bg-muted px-2 py-2 text-xs xl:px-4 xl:text-sm" onClick={onTest}>Testar</button>
      <button disabled={saving} className="col-span-2 min-h-11 rounded-full border border-whatsapp px-3 py-2 text-sm font-medium text-whatsapp" onClick={onSave}>
        {saving ? "Salvando…" : "Salvar"}
      </button>
      <button disabled={saving} className="col-span-2 min-h-11 rounded-full bg-whatsapp px-3 py-2 text-sm font-semibold text-whatsapp-foreground" onClick={onPublish}>
        Publicar
      </button>
    </header>
  );
}
