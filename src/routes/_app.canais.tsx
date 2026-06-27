import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Smartphone, Plus, Pencil, Power, Plug, Loader2, CheckCircle2, XCircle,
  ShieldAlert, QrCode, RefreshCw, Search, LogOut,
} from "lucide-react";
import { toast } from "sonner";
import { channels as seed, type Channel, type Provider, type ChannelStatus, type EvolutionConfig } from "@/lib/mocks";
import { useSession } from "@/lib/session";
import { canManageChannels } from "@/lib/permissions";
import { pushAudit } from "@/lib/audit-log";
import * as evo from "@/lib/evolution";

type ChannelExt = Channel;

function buildEvolutionDefaults(channelId: string, tenantId: string): EvolutionConfig {
  return evo.defaultEvolutionConfig(channelId, tenantId);
}

const initial: ChannelExt[] = seed.map((c) => ({
  ...c,
  evolution:
    c.provider === "EVOLUTION"
      ? buildEvolutionDefaults(c.id, c.tenantId)
      : undefined,
  meta:
    c.provider === "META"
      ? {
          apiUrl: "https://graph.facebook.com/v18.0",
          apiToken: "",
          phoneNumberId: "",
          wabaId: "",
          webhookUrl: "",
          verifyToken: "",
        }
      : undefined,
}));

export const Route = createFileRoute("/_app/canais")({
  component: CanaisPage,
});

function CanaisPage() {
  const { session, user, isSuperAdmin } = useSession();
  const actor = { id: session.userId, role: session.role, tenantId: session.tenantId };
  const canManage = canManageChannels(actor);

  const [items, setItems] = useState<ChannelExt[]>(initial);
  const [editing, setEditing] = useState<ChannelExt | null>(null);
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, "ok" | "fail" | undefined>>({});

  const visible = useMemo(() => items.filter((c) => c.tenantId === session.tenantId), [items, session.tenantId]);

  function openNew() {
    if (!canManage) { toast.error("Sem permissão para criar canais"); return; }
    const id = `c-${Date.now()}`;
    setEditing({
      id, tenantId: session.tenantId, name: "", phone: "",
      provider: "EVOLUTION", status: "pending",
      evolution: buildEvolutionDefaults(id, session.tenantId),
    });
    setOpen(true);
  }
  function openEdit(c: ChannelExt) {
    if (!canManage || (c.tenantId !== session.tenantId && !isSuperAdmin)) {
      toast.error("Sem permissão para editar este canal");
      pushAudit({ tenantId: c.tenantId, actorId: actor.id, actorName: user.name, targetType: "channel", targetId: c.id, targetName: c.name, action: "access.denied", result: "denied" });
      return;
    }
    setEditing({ ...c });
    setOpen(true);
  }
  function save() {
    if (!editing) return;
    const tenantSafe: ChannelExt = { ...editing, tenantId: session.tenantId };
    if (tenantSafe.provider === "EVOLUTION" && !tenantSafe.evolution) {
      tenantSafe.evolution = buildEvolutionDefaults(tenantSafe.id, tenantSafe.tenantId);
    }
    const exists = items.some((c) => c.id === tenantSafe.id);
    setItems((prev) => (exists ? prev.map((c) => (c.id === tenantSafe.id ? tenantSafe : c)) : [...prev, tenantSafe]));
    pushAudit({
      tenantId: tenantSafe.tenantId, actorId: actor.id, actorName: user.name,
      targetType: "channel", targetId: tenantSafe.id, targetName: tenantSafe.name,
      action: exists ? "channel.update" : "channel.create", result: "success",
    });
    toast.success(exists ? "Canal atualizado" : "Canal criado");
    setOpen(false);
  }
  function toggle(c: ChannelExt) {
    if (!canManage) return;
    const next: ChannelStatus = c.status === "connected" ? "disconnected" : "connected";
    setItems((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: next } : x)));
    pushAudit({
      tenantId: c.tenantId, actorId: actor.id, actorName: user.name,
      targetType: "channel", targetId: c.id, targetName: c.name,
      action: next === "connected" ? "channel.instance_connected" : "channel.instance_disconnected",
      result: "success",
    });
  }
  async function testConnection(c: ChannelExt) {
    setTesting(c.id);
    setResult((r) => ({ ...r, [c.id]: undefined }));
    try {
      if (c.provider === "EVOLUTION" && c.evolution) {
        const status = await evo.getInstanceStatus(c.evolution);
        const ok = status === "open";
        setResult((r) => ({ ...r, [c.id]: ok ? "ok" : "fail" }));
        setItems((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: ok ? "connected" : "disconnected" } : x)));
        pushAudit({ tenantId: c.tenantId, actorId: actor.id, actorName: user.name, targetType: "channel", targetId: c.id, targetName: c.name, action: "channel.test", result: ok ? "success" : "error", reason: `status=${status}` });
        toast[ok ? "success" : "error"](ok ? "Instância conectada" : `Instância ${status}`);
      } else {
        await new Promise((r) => setTimeout(r, 600));
        setResult((r) => ({ ...r, [c.id]: "fail" }));
        toast.message("Meta ainda não integrado nesta fase");
      }
    } catch (e) {
      setResult((r) => ({ ...r, [c.id]: "fail" }));
      const msg = e instanceof Error ? e.message : "erro";
      pushAudit({ tenantId: c.tenantId, actorId: actor.id, actorName: user.name, targetType: "channel", targetId: c.id, targetName: c.name, action: "channel.test", result: "error", reason: msg });
      toast.error(`Falha no teste: ${msg}`);
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <Smartphone className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Canais WhatsApp</h1>
            <p className="text-xs text-muted-foreground">
              Empresa ativa · {session.tenantId} · {visible.length} canal(is)
            </p>
          </div>
        </div>
        {canManage && (
          <button onClick={openNew} className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90">
            <Plus className="h-4 w-4" /> Novo canal
          </button>
        )}
      </header>

      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-6 py-2 text-xs text-muted-foreground">
        <ShieldAlert className="h-3.5 w-3.5" /> Cada canal é isolado por tenant_id e nunca é exibido para usuários de outra empresa.
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((c) => (
            <div key={c.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-semibold">{c.name || "Sem nome"}</h3>
                    <span className="rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase">{c.provider}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{c.phone || "Telefone não definido"}</p>
                </div>
                <StatusBadge status={c.status} />
              </div>

              <div className="mt-4 space-y-1 text-xs text-muted-foreground">
                {c.provider === "EVOLUTION" && c.evolution ? (
                  <>
                    <div className="truncate"><b className="text-foreground">URL:</b> {c.evolution.apiUrl}</div>
                    <div className="truncate"><b className="text-foreground">Instância:</b> {c.evolution.instanceName}</div>
                    <div className="truncate"><b className="text-foreground">Webhook:</b> {c.evolution.webhookUrl}</div>
                  </>
                ) : c.provider === "META" && c.meta ? (
                  <>
                    <div className="truncate"><b className="text-foreground">Graph API:</b> {c.meta.apiUrl}</div>
                    <div className="text-amber-600">Meta preparada — não integrada nesta fase.</div>
                  </>
                ) : (
                  <div className="text-amber-600">Configuração pendente</div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button onClick={() => testConnection(c)} disabled={testing === c.id}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
                  {testing === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
                  Testar
                </button>
                {result[c.id] === "ok" && <span className="inline-flex items-center gap-1 text-xs text-whatsapp"><CheckCircle2 className="h-3.5 w-3.5" /> OK</span>}
                {result[c.id] === "fail" && <span className="inline-flex items-center gap-1 text-xs text-destructive"><XCircle className="h-3.5 w-3.5" /> Falhou</span>}
                <button disabled={!canManage} onClick={() => openEdit(c)} className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-accent disabled:opacity-30" title="Editar">
                  <Pencil className="h-4 w-4" />
                </button>
                <button disabled={!canManage} onClick={() => toggle(c)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent disabled:opacity-30" title="Conectar/Desconectar">
                  <Power className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          {visible.length === 0 && (
            <div className="col-span-full rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Nenhum canal cadastrado para esta empresa.
            </div>
          )}
        </div>
      </div>

      {open && editing && (
        <ChannelModal
          channel={editing}
          onChange={setEditing}
          onClose={() => setOpen(false)}
          onSave={save}
          existing={items.some((c) => c.id === editing.id)}
          actor={actor}
          actorName={user.name}
        />
      )}
    </div>
  );
}

// ─── Modal de edição ────────────────────────────────────────────────────────
function ChannelModal({
  channel, onChange, onClose, onSave, existing, actor, actorName,
}: {
  channel: ChannelExt;
  onChange: (c: ChannelExt) => void;
  onClose: () => void;
  onSave: () => void;
  existing: boolean;
  actor: { id: string; tenantId: string };
  actorName: string;
}) {
  const [tab, setTab] = useState<"basico" | "integracao" | "eventos">("basico");
  const [qr, setQr] = useState<string | null>(null);
  const [loading, setLoading] = useState<null | "qr" | "fetch" | "status" | "logout">(null);
  const [instances, setInstances] = useState<evo.EvolutionInstance[] | null>(null);

  const evoCfg = channel.evolution;

  function updateEvo(patch: Partial<EvolutionConfig>) {
    onChange({ ...channel, evolution: { ...(channel.evolution ?? evo.defaultEvolutionConfig(channel.id, channel.tenantId)), ...patch } });
  }

  async function genQr() {
    if (!evoCfg) return;
    setLoading("qr");
    try {
      const data = await evo.getQRCode(evoCfg);
      setQr(data);
      pushAudit({ tenantId: channel.tenantId, actorId: actor.id, actorName, targetType: "channel", targetId: channel.id, targetName: channel.name, action: "channel.qr_generated", result: data ? "success" : "error" });
      if (!data) toast.error("QR Code não disponível");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "erro";
      pushAudit({ tenantId: channel.tenantId, actorId: actor.id, actorName, targetType: "channel", targetId: channel.id, targetName: channel.name, action: "channel.qr_generated", result: "error", reason: msg });
      toast.error(`Falha ao gerar QR: ${msg}`);
    } finally { setLoading(null); }
  }

  async function fetchInst() {
    if (!evoCfg) return;
    setLoading("fetch");
    try {
      const list = await evo.fetchInstances(evoCfg);
      setInstances(list);
      toast.success(`${list.length} instância(s) encontrada(s)`);
    } catch (e) {
      toast.error(`Erro ao buscar instâncias: ${e instanceof Error ? e.message : "erro"}`);
    } finally { setLoading(null); }
  }

  async function status() {
    if (!evoCfg) return;
    setLoading("status");
    try {
      const s = await evo.getInstanceStatus(evoCfg);
      toast[s === "open" ? "success" : "message"](`Status: ${s}`);
    } catch (e) {
      toast.error(`Falha no status: ${e instanceof Error ? e.message : "erro"}`);
    } finally { setLoading(null); }
  }

  async function logout() {
    if (!evoCfg) return;
    setLoading("logout");
    try {
      await evo.logoutInstance(evoCfg);
      toast.success("Instância desconectada");
      pushAudit({ tenantId: channel.tenantId, actorId: actor.id, actorName, targetType: "channel", targetId: channel.id, targetName: channel.name, action: "channel.instance_disconnected", result: "success" });
    } catch (e) {
      toast.error(`Erro ao desconectar: ${e instanceof Error ? e.message : "erro"}`);
    } finally { setLoading(null); }
  }

  async function applyWebhook() {
    if (!evoCfg) return;
    try {
      await evo.configureWebhook(evoCfg, evoCfg.webhookUrl);
      toast.success("Webhook configurado");
      pushAudit({ tenantId: channel.tenantId, actorId: actor.id, actorName, targetType: "channel", targetId: channel.id, targetName: channel.name, action: "channel.webhook_configured", result: "success" });
    } catch (e) {
      toast.error(`Erro: ${e instanceof Error ? e.message : "erro"}`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">{existing ? "Editar canal" : "Novo canal"}</h2>

        <div className="mb-4 flex gap-1 rounded-md bg-muted p-1 text-xs">
          {[
            { v: "basico", l: "Básico" },
            { v: "integracao", l: "Integração" },
            { v: "eventos", l: "Eventos" },
          ].map((t) => (
            <button key={t.v} onClick={() => setTab(t.v as typeof tab)}
              className={`flex-1 rounded px-3 py-1.5 font-medium ${tab === t.v ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {t.l}
            </button>
          ))}
        </div>

        {tab === "basico" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Nome" value={channel.name} onChange={(v) => onChange({ ...channel, name: v })} />
              <Field label="Telefone" value={channel.phone} onChange={(v) => onChange({ ...channel, phone: v })} />
            </div>
            <Select label="Provedor" value={channel.provider} options={["EVOLUTION", "META"]}
              onChange={(v) => {
                const provider = v as Provider;
                const patch: ChannelExt = { ...channel, provider };
                if (provider === "EVOLUTION" && !patch.evolution) patch.evolution = evo.defaultEvolutionConfig(channel.id, channel.tenantId);
                onChange(patch);
              }} />
            <p className="rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">
              Canal será vinculado à empresa <b>{channel.tenantId}</b>.
            </p>
          </div>
        )}

        {tab === "integracao" && channel.provider === "EVOLUTION" && evoCfg && (
          <div className="space-y-3">
            <Field label="EVOLUTION_API_URL" value={evoCfg.apiUrl} onChange={(v) => updateEvo({ apiUrl: v })} />
            <Field label="EVOLUTION_API_KEY" value={evoCfg.apiKey} onChange={(v) => updateEvo({ apiKey: v })} placeholder="cole sua API key" />
            <div className="grid grid-cols-2 gap-3">
              <Field label="instance_name" value={evoCfg.instanceName} onChange={(v) => updateEvo({ instanceName: v })} />
              <Field label="webhook_url" value={evoCfg.webhookUrl} onChange={(v) => updateEvo({ webhookUrl: v })} />
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <BtnAct onClick={fetchInst} loading={loading === "fetch"} icon={Search} label="Buscar instâncias" />
              <BtnAct onClick={genQr} loading={loading === "qr"} icon={QrCode} label="Gerar QR Code" />
              <BtnAct onClick={status} loading={loading === "status"} icon={RefreshCw} label="Verificar status" />
              <BtnAct onClick={logout} loading={loading === "logout"} icon={LogOut} label="Desconectar" />
              <BtnAct onClick={applyWebhook} icon={Plug} label="Aplicar webhook" />
            </div>

            {qr && (
              <div className="mt-2 grid place-items-center rounded-md border border-border bg-background p-3">
                <img src={qr} alt="QR Code" className="h-48 w-48" />
                <p className="mt-2 text-[11px] text-muted-foreground">Abra o WhatsApp → Aparelhos conectados → Conectar aparelho</p>
              </div>
            )}

            {instances && (
              <div className="rounded-md border border-border bg-muted/30 p-2 text-xs">
                <div className="mb-1 font-medium">Instâncias retornadas:</div>
                <ul className="space-y-1">
                  {instances.map((i) => (
                    <li key={i.instanceName} className="flex items-center justify-between">
                      <span>{i.instanceName}{i.phone ? ` · ${i.phone}` : ""}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${i.status === "open" ? "bg-whatsapp/15 text-whatsapp" : "bg-muted text-muted-foreground"}`}>{i.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {tab === "integracao" && channel.provider === "META" && (
          <div className="space-y-3">
            <Field label="Graph API URL" value={channel.meta?.apiUrl ?? ""} onChange={(v) => onChange({ ...channel, meta: { ...(channel.meta!), apiUrl: v } })} />
            <Field label="API Token" value={channel.meta?.apiToken ?? ""} onChange={(v) => onChange({ ...channel, meta: { ...(channel.meta!), apiToken: v } })} />
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
              A integração Meta WhatsApp Cloud API será habilitada em fase posterior. Os campos ficam preparados.
            </p>
          </div>
        )}

        {tab === "eventos" && channel.provider === "EVOLUTION" && evoCfg && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Tipos de mensagem que esta instância vai processar:</p>
            {(["text", "image", "audio", "document", "video"] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-2 text-sm">
                <input type="checkbox" checked={evoCfg.events[k]} onChange={(e) => updateEvo({ events: { ...evoCfg.events, [k]: e.target.checked } })} />
                <span className="capitalize">{k}</span>
              </label>
            ))}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
          <button onClick={onSave} className="rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90">Salvar</button>
        </div>
      </div>
    </div>
  );
}

function BtnAct({ onClick, loading, icon: Icon, label }: { onClick: () => void; loading?: boolean; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <button onClick={onClick} disabled={loading} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />} {label}
    </button>
  );
}

function StatusBadge({ status }: { status: ChannelStatus }) {
  const map: Record<ChannelStatus, { label: string; cls: string }> = {
    connected: { label: "Conectado", cls: "bg-whatsapp/15 text-whatsapp" },
    disconnected: { label: "Desconectado", cls: "bg-muted text-muted-foreground" },
    pending: { label: "Pendente", cls: "bg-amber-500/15 text-amber-600" },
    error: { label: "Erro", cls: "bg-destructive/15 text-destructive" },
  };
  const s = map[status];
  return <span className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium ${s.cls}`}>{s.label}</span>;
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp" />
    </label>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp">
        {options.map((o) => (<option key={o} value={o}>{o}</option>))}
      </select>
    </label>
  );
}
