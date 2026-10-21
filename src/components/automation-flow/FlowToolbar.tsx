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
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3">
      <button className="text-sm text-muted-foreground" onClick={onBack}>← Fluxos</button>
      <input
        value={name}
        onChange={(event) => onName(event.target.value)}
        placeholder="Nome do fluxo"
        className="min-w-48 flex-1 rounded-xl border border-input bg-background px-3 py-2 text-sm font-medium"
      />
      <select
        value={status}
        onChange={(event) => onStatus(event.target.value as FlowStatus)}
        className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
      >
        <option value="draft">Rascunho</option>
        <option value="active">Publicado</option>
        <option value="paused">Pausado</option>
      </select>
      <button className="rounded-full bg-muted px-4 py-2 text-sm" onClick={onSettings}>Configurações</button>
      <button className="rounded-full bg-muted px-4 py-2 text-sm" onClick={onTest}>Testar</button>
      <button disabled={saving} className="rounded-full border border-whatsapp px-4 py-2 text-sm font-medium text-whatsapp" onClick={onSave}>
        {saving ? "Salvando…" : "Salvar"}
      </button>
      <button disabled={saving} className="rounded-full bg-whatsapp px-4 py-2 text-sm font-semibold text-whatsapp-foreground" onClick={onPublish}>
        Publicar
      </button>
    </header>
  );
}
