import { useEffect, useState } from "react";
import type { FlowKind } from "@/lib/automation-flow";

export type FlowChannel = { id: string; name: string; channelType: string; status: string };
export type FlowTemplate = { name: string; language: string; bodyText: string | null };

export function FlowSettings({
  kind,
  channelIds,
  dispatchChannelId,
  templateName,
  templateLanguage,
  channels,
  onKind,
  onChannels,
  onDispatch,
  onTemplate,
  onClose,
}: {
  kind: FlowKind;
  channelIds: string[];
  dispatchChannelId: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  channels: FlowChannel[];
  onKind: (kind: FlowKind) => void;
  onChannels: (ids: string[]) => void;
  onDispatch: (id: string | null) => void;
  onTemplate: (name: string | null, language: string | null) => void;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<FlowTemplate[]>([]);
  const selected = channels.find((channel) => channel.id === dispatchChannelId);

  useEffect(() => {
    if (kind !== "sales" || selected?.channelType !== "meta" || !dispatchChannelId) {
      setTemplates([]);
      return;
    }
    void fetch(`/api/automation-flows?view=templates&channelId=${dispatchChannelId}`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { templates?: FlowTemplate[] };
        setTemplates(body.templates ?? []);
      });
  }, [kind, selected?.channelType, dispatchChannelId]);

  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Configurações do fluxo</h2>
        <button className="text-xs text-muted-foreground" onClick={onClose}>Fechar</button>
      </div>
      <label className="mb-3 block text-xs">
        Tipo
        <select value={kind} onChange={(event) => onKind(event.target.value as FlowKind)} className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm">
          <option value="attendance">Atendimento</option>
          <option value="sales">Vendas</option>
        </select>
      </label>
      {kind === "attendance" ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Ramais ativos desta empresa. Um número fica em um fluxo só.</p>
          {channels.map((channel) => (
            <label key={channel.id} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={channelIds.includes(channel.id)}
                onChange={(event) =>
                  onChannels(event.target.checked ? [...channelIds, channel.id] : channelIds.filter((id) => id !== channel.id))
                }
              />
              {channel.name}
            </label>
          ))}
          {channels.length === 0 && <p className="text-xs text-muted-foreground">Nenhum ramal ativo.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block text-xs">
            Ramal do disparo
            <select value={dispatchChannelId ?? ""} onChange={(event) => onDispatch(event.target.value || null)} className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm">
              <option value="">Selecione</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>{channel.name}</option>
              ))}
            </select>
          </label>
          {selected?.channelType === "meta" && (
            <label className="block text-xs">
              Mensagem aprovada pela Meta
              <select
                value={templateName ? `${templateName}::${templateLanguage}` : ""}
                onChange={(event) => {
                  const [name, language] = event.target.value.split("::");
                  onTemplate(name || null, language || null);
                }}
                className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Selecione</option>
                {templates.map((template) => (
                  <option key={`${template.name}-${template.language}`} value={`${template.name}::${template.language}`}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </aside>
  );
}
