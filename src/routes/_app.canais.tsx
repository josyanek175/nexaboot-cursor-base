import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Smartphone, Plus, Loader2, QrCode, RefreshCw, Power, Trash2,
  ShieldAlert, X, CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { ApiRequestError, apiGet, apiPost, apiDelete, apiPatch, getApiErrorMessage } from "@/lib/api";
import { formatChannelPhoneForDisplay } from "@/lib/phone";
import { useAuth } from "@/lib/auth";
import { canManageMetaCoexistence } from "@/lib/permissions";
import { MetaCoexistenceModal } from "@/components/meta-coexistence-modal";

type ChannelStatus = "disconnected" | "connecting" | "qrcode" | "connected" | "error" | string;

interface Channel {
  id: string;
  company_id: string | null;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  display_phone_number?: string | null;
  channel_type: string;
  evolution_instance_name: string | null;
  status: ChannelStatus;
  last_connected_at: string | null;
  last_webhook_at?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  meta_connection_mode?: string | null;
}

export const Route = createFileRoute("/_app/canais")({
  component: CanaisPage,
});

function CanaisPage() {
  const { user } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [evolutionConfigured, setEvolutionConfigured] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showAddMeta, setShowAddMeta] = useState(false);
  const [qrChannel, setQrChannel] = useState<Channel | null>(null);
  const [metaTokenChannel, setMetaTokenChannel] = useState<Channel | null>(null);
  const [showCoexistence, setShowCoexistence] = useState(false);
  const [coexistenceAvailable, setCoexistenceAvailable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const canCoexistence = canManageMetaCoexistence(user?.role);

  const load = useCallback(async () => {
    try {
      const [data, metaData] = await Promise.all([
        apiGet("/evolution/channels"),
        apiGet("/meta/channels").catch(() => ({
          channels: [] as {
            id: string;
            display_phone_number?: string | null;
            last_webhook_at?: string | null;
            meta_connection_mode?: string | null;
          }[],
        })),
      ]);
      const metaById = new Map(
        (metaData.channels ?? []).map(
          (m: {
            id: string;
            display_phone_number?: string | null;
            last_webhook_at?: string | null;
            meta_connection_mode?: string | null;
          }) => [m.id, m],
        ),
      );
      const merged = (data.channels ?? []).map((c: Channel) => {
        const meta = metaById.get(c.id);
        return meta
          ? {
              ...c,
              display_phone_number: meta.display_phone_number ?? c.display_phone_number,
              last_webhook_at: meta.last_webhook_at ?? null,
              meta_connection_mode: meta.meta_connection_mode ?? "cloud_api",
            }
          : c;
      });
      setChannels(merged);
      setEvolutionConfigured(data.evolutionConfigured ?? false);
    } catch (e) {
      toast.error(`Falha ao carregar canais: ${e instanceof Error ? e.message : "erro"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!canCoexistence) {
      setCoexistenceAvailable(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const health = await apiGet("/health");
        if (!cancelled) {
          setCoexistenceAvailable(Boolean(health?.metaCoexistenceEnabled));
        }
      } catch {
        if (!cancelled) setCoexistenceAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canCoexistence]);

  async function refreshStatus(c: Channel) {
    const isMeta = c.channel_type?.toLowerCase() === "meta";
    setBusy(c.id);
    try {
      const path = isMeta
        ? `/meta/channels/${c.id}/status`
        : `/evolution/channels/${c.id}/status`;
      const r = await apiGet(path);

      if (isMeta) {
        if (r.metaError) {
          toast.error(r.metaError.message || "Falha ao consultar status Meta");
        } else {
          const graph = r.graph as Record<string, unknown> | null | undefined;
          const verified = graph?.verified_name != null ? String(graph.verified_name) : null;
          const display = graph?.display_phone_number != null ? String(graph.display_phone_number) : null;
          const quality = graph?.quality_rating != null ? String(graph.quality_rating) : null;
          const summary = [verified, display, quality ? `qualidade: ${quality}` : null]
            .filter(Boolean)
            .join(" · ");
          toast.success(summary ? `Meta OK: ${summary}` : `Status Meta: ${labelOf(r.status)}`);
        }
        setChannels((prev) =>
          prev.map((x) => (x.id === c.id ? { ...x, status: r.status ?? x.status } : x)),
        );
        return;
      }

      setChannels((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: r.status } : x)));
      toast.message(`Status: ${labelOf(r.status)}`);
    } catch (e) {
      toast.error(`Falha ao consultar status: ${e instanceof Error ? e.message : "erro"}`);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(c: Channel) {
    if (!confirm(`Desconectar o canal "${c.name}"?`)) return;
    setBusy(c.id);
    try {
      await apiPost(`/evolution/channels/${c.id}/disconnect`);
      toast.success("Canal desconectado");
      await load();
    } catch (e) {
      toast.error(`Falha ao desconectar: ${e instanceof Error ? e.message : "erro"}`);
    } finally {
      setBusy(null);
    }
  }

  async function remove(c: Channel) {
    if (!confirm(`Remover o canal "${c.name}"? O histórico de conversas é preservado.`)) return;
    setBusy(c.id);
    try {
      await apiDelete(`/evolution/channels/${c.id}`);
      toast.success("Canal removido");
      await load();
    } catch (e) {
      toast.error(`Falha ao remover: ${e instanceof Error ? e.message : "erro"}`);
    } finally {
      setBusy(null);
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
              {channels.length} canal(is) · Evolution API e Meta Cloud API
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {coexistenceAvailable && (
            <button
              onClick={() => setShowCoexistence(true)}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              Conectar número existente em coexistência
            </button>
          )}
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Adicionar Evolution
          </button>
          <button
            onClick={() => setShowAddMeta(true)}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            <Plus className="h-4 w-4" /> Adicionar Meta
          </button>
        </div>
      </header>

      {!evolutionConfigured && (
        <div className="flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-6 py-2 text-xs text-amber-800">
          <ShieldAlert className="h-3.5 w-3.5" />
          Evolution não configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no servidor para criar instâncias e gerar QR Code.
        </div>
      )}

      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="grid place-items-center py-20 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {channels.map((c) => {
              const isMeta = c.channel_type?.toLowerCase() === "meta";
              const phoneLabel = formatChannelPhoneForDisplay({
                channelType: c.channel_type,
                displayPhoneNumber: c.display_phone_number,
                phoneNumber: c.phone_number,
              });
              return (
              <div key={c.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-semibold">{c.name || "Sem nome"}</h3>
                      <span className="rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase">
                        {c.channel_type}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {isMeta
                        ? c.meta_connection_mode === "coexistence"
                          ? "Meta Coexistence (Embedded Signup)"
                          : "Meta WhatsApp Cloud API"
                        : `Instância: ${c.evolution_instance_name || "—"}`}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={c.id}>
                      channelId: {c.id}
                    </p>
                    {phoneLabel && (
                      <p className="truncate text-xs text-muted-foreground">{phoneLabel}</p>
                    )}
                  </div>
                  <StatusBadge status={c.status} />
                </div>

                <p className="mt-3 text-[11px] text-muted-foreground">
                  {isMeta
                    ? `Último webhook: ${
                        c.last_webhook_at
                          ? new Date(c.last_webhook_at).toLocaleString("pt-BR")
                          : "nenhum recebido ainda"
                      }`
                    : `Última conexão: ${
                        c.last_connected_at
                          ? new Date(c.last_connected_at).toLocaleString("pt-BR")
                          : "nunca"
                      }`}
                </p>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => (isMeta ? setMetaTokenChannel(c) : setQrChannel(c))}
                    className="inline-flex items-center gap-1.5 rounded-md bg-whatsapp px-2.5 py-1.5 text-xs font-medium text-whatsapp-foreground hover:opacity-90"
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    {isMeta ? "Conectar Meta" : c.status === "connected" ? "Reconectar" : "Conectar WhatsApp"}
                  </button>
                  <button
                    onClick={() => refreshStatus(c)}
                    disabled={busy === c.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                  >
                    {busy === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    Status
                  </button>
                  <button
                    onClick={() => disconnect(c)}
                    disabled={busy === c.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                    title="Desconectar"
                  >
                    <Power className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => remove(c)}
                    disabled={busy === c.id}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    title="Remover canal"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
            })}
            {channels.length === 0 && (
              <div className="col-span-full rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                Nenhum canal cadastrado. Clique em “Adicionar Evolution” ou “Adicionar Meta” para começar.
              </div>
            )}
          </div>
        )}
      </div>

      {showAdd && (
        <AddChannelModal
          onClose={() => setShowAdd(false)}
          onCreated={async (created) => {
            setShowAdd(false);
            await load();
            setQrChannel(created);
          }}
        />
      )}

      {showAddMeta && (
        <AddMetaChannelModal
          onClose={() => setShowAddMeta(false)}
          onCreated={async (createdId) => {
            setShowAddMeta(false);
            toast.success(`Canal Meta criado · channelId ${createdId}`);
            await load();
          }}
        />
      )}

      {metaTokenChannel && (
        <MetaTokenModal
          channel={metaTokenChannel}
          onClose={() => { setMetaTokenChannel(null); void load(); }}
          onSaved={() => { toast.success("Token Meta salvo"); setMetaTokenChannel(null); void load(); }}
        />
      )}

      {showCoexistence && (
        <MetaCoexistenceModal
          onClose={() => setShowCoexistence(false)}
          onConnected={() => {
            setShowCoexistence(false);
            void load();
          }}
        />
      )}

      {qrChannel && (
        <QrModal
          channel={qrChannel}
          onClose={() => { setQrChannel(null); void load(); }}
          onConnected={() => { toast.success("WhatsApp conectado!"); setQrChannel(null); void load(); }}
        />
      )}
    </div>
  );
}

// ─── Modal: adicionar número ─────────────────────────────────────────────────
function AddChannelModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (channel: Channel) => void;
}) {
  const [name, setName] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim() || !instanceName.trim()) {
      toast.error("Preencha o nome do canal e o nome da instância");
      return;
    }
    setSaving(true);
    try {
      const r = await apiPost("/evolution/channels", {
        name: name.trim(),
        instanceName: instanceName.trim(),
        companyName: companyName.trim() || undefined,
      });
      const evo = r.evolution ?? {};
      if (evo.configured === false) {
        toast.message("Canal salvo. Configure a Evolution no servidor para gerar QR.");
      } else if (evo.error || evo.createError) {
        toast.error(`Canal salvo, mas a Evolution retornou erro: ${evo.error ?? evo.createError}`);
      } else {
        toast.success("Canal criado na Evolution");
      }
      onCreated(r.channel);
    } catch (e) {
      toast.error(`Falha ao criar canal: ${e instanceof Error ? e.message : "erro"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Adicionar número WhatsApp" onClose={onClose}>
      <div className="space-y-3">
        <Field
          label="Nome do canal"
          value={name}
          onChange={setName}
          placeholder="Comercial, Atendimento, Financeiro…"
        />
        <Field
          label="Nome da instância Evolution"
          value={instanceName}
          onChange={(v) => setInstanceName(v.replace(/\s+/g, "-").toLowerCase())}
          placeholder="comercial-filtros-e-velas"
        />
        <p className="-mt-1 text-[11px] text-muted-foreground">
          Use apenas letras, números, hífen, ponto ou underline. Será o identificador na Evolution.
        </p>
        <Field
          label="Empresa (opcional)"
          value={companyName}
          onChange={setCompanyName}
          placeholder="Empresa Padrão"
        />
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Salvar e conectar
        </button>
      </div>
    </ModalShell>
  );
}

function metaCreateErrorToast(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const code = error.body.error ?? "";
    if (error.status === 401) return "Sessão expirada. Faça login novamente.";
    if (code === "invalid_input") return "Preencha todos os campos corretamente.";
    if (code === "invalid_status") return "Status inválido.";
    if (code === "token_graph_validation_failed") {
      return error.body.message?.trim() ||
        "Token rejeitado pela Meta. Confira WABA e Phone Number ID.";
    }
    if (code === "phone_number_id_already_exists") {
      return "Este Phone Number ID já está cadastrado.";
    }
    if (code === "phone_number_id_belongs_to_another_company") {
      return "Este número já pertence a outra empresa.";
    }
    if (code === "missing_encryption_key") {
      return "Criptografia de token não configurada no servidor.";
    }
  }
  return getApiErrorMessage(error);
}

// ─── Modal: adicionar canal Meta Cloud API ───────────────────────────────────
function AddMetaChannelModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (channelId: string) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [displayPhoneNumber, setDisplayPhoneNumber] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [webhookVerifyToken, setWebhookVerifyToken] = useState("");
  const [saving, setSaving] = useState(false);

  function clearSecrets() {
    setAccessToken("");
    setWebhookVerifyToken("");
  }

  useEffect(() => () => { clearSecrets(); }, []);

  function handleClose() {
    clearSecrets();
    onClose();
  }

  async function save() {
    const payload = {
      name: name.trim(),
      waba_id: wabaId.trim(),
      phone_number_id: phoneNumberId.trim(),
      business_id: businessId.trim(),
      display_phone_number: displayPhoneNumber.trim(),
      access_token: accessToken.trim(),
      webhook_verify_token: webhookVerifyToken.trim(),
    };
    if (
      !payload.name || payload.name.length > 120 ||
      !payload.waba_id || payload.waba_id.length > 120 ||
      !payload.phone_number_id || payload.phone_number_id.length > 120 ||
      !payload.business_id || payload.business_id.length > 120 ||
      !payload.display_phone_number || payload.display_phone_number.length > 40 ||
      !payload.access_token || payload.access_token.length > 4096 ||
      !payload.webhook_verify_token || payload.webhook_verify_token.length > 256
    ) {
      toast.error("Preencha todos os campos corretamente.");
      return;
    }
    setSaving(true);
    try {
      const r = await apiPost("/meta/channels", payload);
      const channelId = String(r?.channel?.id ?? "");
      if (!channelId) {
        toast.error("Canal criado, mas a API não devolveu channelId.");
        return;
      }
      console.log("[META_CHANNEL_CREATED]", {
        channelId,
        phone_number_id: payload.phone_number_id,
        waba_id: payload.waba_id,
      });
      clearSecrets();
      await onCreated(channelId);
    } catch (e) {
      toast.error(metaCreateErrorToast(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Adicionar canal Meta Cloud API" onClose={handleClose}>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Cadastra um número já registrado na Meta. O access token é cifrado no servidor
          e não fica salvo no navegador. Anote o <b>channelId</b> do toast após o sucesso
          para testar roteamento de conversas.
        </p>
        <Field label="Nome do canal" value={name} onChange={setName} placeholder="Comercial Meta 2" />
        <Field label="WABA ID" value={wabaId} onChange={setWabaId} placeholder="ID da WhatsApp Business Account" />
        <Field label="Phone Number ID" value={phoneNumberId} onChange={setPhoneNumberId} placeholder="ID do número na Cloud API" />
        <Field label="Business ID" value={businessId} onChange={setBusinessId} placeholder="ID do Business Manager" />
        <Field label="Número exibido" value={displayPhoneNumber} onChange={setDisplayPhoneNumber} placeholder="+55 34 99999-0000" />
        <Field
          label="Access Token"
          value={accessToken}
          onChange={setAccessToken}
          type="password"
          autoComplete="off"
          placeholder="EAAxxxxxxxx…"
        />
        <Field
          label="Webhook Verify Token"
          value={webhookVerifyToken}
          onChange={setWebhookVerifyToken}
          type="password"
          autoComplete="off"
          placeholder="mesmo token configurado no app Meta, se aplicável"
        />
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={handleClose} className="rounded-md px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
        <button
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Salvar canal
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Modal: salvar token Meta ────────────────────────────────────────────────
function MetaTokenModal({
  channel, onClose, onSaved,
}: {
  channel: Channel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [accessToken, setAccessToken] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!accessToken.trim()) {
      toast.error("Cole o access token permanente do painel Meta");
      return;
    }
    setSaving(true);
    try {
      await apiDelete(`/meta/channels/${channel.id}/token`);
      await apiPatch(`/meta/channels/${channel.id}`, { access_token: accessToken.trim() });
      onSaved();
    } catch (e) {
      toast.error(`Falha ao salvar token: ${e instanceof Error ? e.message : "erro"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title={`Conectar Meta: ${channel.name}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Cole o <b>access token permanente</b> do app Meta (WhatsApp → API Setup).
          O token antigo será removido e um novo será cifrado com a{" "}
          <code>META_TOKEN_ENCRYPTION_KEY</code> atual do <b>nexaboot-web</b>.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Access token</span>
          <textarea
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            rows={4}
            placeholder="EAAxxxxxxxx..."
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-whatsapp"
          />
        </label>
        <p className="text-[11px] text-muted-foreground">
          Confirme também <code>META_TOKEN_ENCRYPTION_KEY</code> no serviço <b>nexaboot-web</b> (EasyPanel), não no Evolution.
        </p>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
        <button
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Salvar token
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Modal: QR Code + polling ────────────────────────────────────────────────
function QrModal({
  channel, onClose, onConnected,
}: {
  channel: Channel;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<ChannelStatus>(channel.status);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startConnect = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiPost(`/evolution/channels/${channel.id}/connect`);
      setStatus(r.status);
      setQr(r.qrcode ?? null);
      if (r.status === "connected") { onConnected(); return; }
    } catch (e) {
      toast.error(`Falha ao iniciar conexão: ${e instanceof Error ? e.message : "erro"}`);
    } finally {
      setLoading(false);
    }
  }, [channel.id, onConnected]);

  useEffect(() => {
    void startConnect();
  }, [startConnect]);

  // Polling de status enquanto o QR está aberto (a cada 4s).
  useEffect(() => {
    pollRef.current = setInterval(async () => {
      try {
        const r = await apiGet(`/evolution/channels/${channel.id}/status`);
        setStatus(r.status);
        if (r.status === "connected") {
          if (pollRef.current) clearInterval(pollRef.current);
          onConnected();
        } else if (r.status === "disconnected" || r.status === "qrcode") {
          // QR pode expirar: tenta renovar o QR se ainda não conectado.
          const q = await apiGet(`/evolution/channels/${channel.id}/qrcode`);
          if (q.qrcode) setQr(q.qrcode);
          if (q.status === "connected") {
            if (pollRef.current) clearInterval(pollRef.current);
            onConnected();
          }
        }
      } catch {
        // ignora erros transitórios durante o polling
      }
    }, 4000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [channel.id, onConnected]);

  return (
    <ModalShell title={`Conectar: ${channel.name}`} onClose={onClose}>
      <div className="flex flex-col items-center gap-3">
        <StatusBadge status={status} />
        <div className="grid h-64 w-64 place-items-center rounded-lg border border-border bg-background">
          {status === "connected" ? (
            <div className="flex flex-col items-center gap-2 text-whatsapp">
              <CheckCircle2 className="h-12 w-12" />
              <span className="text-sm font-medium">Conectado</span>
            </div>
          ) : loading ? (
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          ) : qr ? (
            <img src={qr} alt="QR Code" className="h-60 w-60" />
          ) : (
            <div className="px-4 text-center text-xs text-muted-foreground">
              QR Code indisponível. Tente atualizar.
            </div>
          )}
        </div>
        <p className="max-w-xs text-center text-xs text-muted-foreground">
          No celular, abra <b>WhatsApp &gt; Aparelhos conectados &gt; Conectar aparelho</b> e escaneie o código.
        </p>
        <button
          onClick={startConnect}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Atualizar QR
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Helpers de UI ───────────────────────────────────────────────────────────
function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function labelOf(status: ChannelStatus): string {
  const map: Record<string, string> = {
    connected: "Conectado",
    connecting: "Conectando",
    qrcode: "Aguardando QR",
    disconnected: "Desconectado",
    error: "Erro",
    ACTIVE: "Ativo",
    PAUSED: "Pausado",
    BLOCKED: "Bloqueado",
    DISCONNECTED: "Desconectado",
    PENDING_REVIEW: "Em revisão",
    ERROR: "Erro",
  };
  return map[status] ?? status;
}

function StatusBadge({ status }: { status: ChannelStatus }) {
  const map: Record<string, string> = {
    connected: "bg-whatsapp/15 text-whatsapp",
    ACTIVE: "bg-whatsapp/15 text-whatsapp",
    connecting: "bg-amber-500/15 text-amber-600",
    qrcode: "bg-blue-500/15 text-blue-600",
    disconnected: "bg-muted text-muted-foreground",
    DISCONNECTED: "bg-muted text-muted-foreground",
    PAUSED: "bg-amber-500/15 text-amber-600",
    error: "bg-destructive/15 text-destructive",
    ERROR: "bg-destructive/15 text-destructive",
    BLOCKED: "bg-destructive/15 text-destructive",
    PENDING_REVIEW: "bg-blue-500/15 text-blue-600",
  };
  return (
    <span className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium ${map[status] ?? "bg-muted text-muted-foreground"}`}>
      {labelOf(status)}
    </span>
  );
}

function Field({
  label, value, onChange, placeholder, type = "text", autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type={type}
        autoComplete={autoComplete}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp"
      />
    </label>
  );
}
