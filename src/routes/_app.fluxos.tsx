import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AutomationFlowBuilder, type BuilderFlow } from "@/components/automation-flow/AutomationFlowBuilder";
import type { FlowChannel } from "@/components/automation-flow/FlowSettings";
import { emptyDefinition, type FlowStatus } from "@/lib/automation-flow";

export const Route = createFileRoute("/_app/fluxos")({
  component: FluxosPage,
  head: () => ({ meta: [{ title: "Fluxos — NexaBoot" }] }),
});

function FluxosPage() {
  const [flows, setFlows] = useState<BuilderFlow[]>([]);
  const [channels, setChannels] = useState<FlowChannel[]>([]);
  const [editing, setEditing] = useState<BuilderFlow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [flowRes, channelRes] = await Promise.all([
      fetch("/api/automation-flows", { credentials: "include" }),
      fetch("/api/automation-flows?view=channels", { credentials: "include" }),
    ]);
    if (flowRes.ok) {
      setError(null);
      setFlows(((await flowRes.json()) as { flows: BuilderFlow[] }).flows ?? []);
    } else {
      const body = (await flowRes.json().catch(() => ({}))) as { message?: string; flowName?: string | null };
      setError(body.message ? `${body.flowName ? body.flowName + ": " : ""}${body.message}` : "Não foi possível ler os fluxos.");
      setFlows([]);
    }
    if (channelRes.ok) setChannels(((await channelRes.json()) as { channels: FlowChannel[] }).channels ?? []);
  }, []);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  if (editing) {
    return (
      <AutomationFlowBuilder
        key={editing.id || "novo"}
        flow={editing}
        channels={channels}
        onClose={() => {
          setEditing(null);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Fluxos</h1>
          <p className="text-sm text-muted-foreground">Desenhe a conversa. Os ramais ficam nas configurações do fluxo.</p>
        </div>
        <button
          className="rounded-full bg-whatsapp px-4 py-2 text-sm font-semibold text-whatsapp-foreground"
          onClick={() =>
            setEditing({
              id: "",
              name: "",
              kind: "attendance",
              status: "draft",
              definition: emptyDefinition(),
              dispatch_channel_id: null,
              meta_template_name: null,
              meta_template_language: null,
              channel_ids: [],
            })
          }
        >
          Novo fluxo
        </button>
      </div>
      {error && <p className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</p>}
      {!loading && flows.length === 0 && (
        <p className="rounded-2xl border border-dashed border-border p-8 text-sm text-muted-foreground">Nenhum fluxo ainda.</p>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {flows.map((flow) => (
          <li key={flow.id} className="rounded-2xl border border-border bg-card p-4">
            <div className="font-semibold">{flow.name}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {flow.kind === "attendance" ? "Atendimento" : "Vendas"} · {statusLabel(flow.status)} · {flow.definition?.steps?.length ?? 0} etapas
            </div>
            <button className="mt-3 text-sm font-medium text-whatsapp" onClick={() => setEditing(flow)}>
              Editar
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusLabel(status: FlowStatus) {
  if (status === "active") return "Publicado";
  if (status === "paused") return "Pausado";
  return "Rascunho";
}
