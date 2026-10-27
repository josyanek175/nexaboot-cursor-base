import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { apiGet, apiPost, getApiErrorMessage } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "sonner";
type ExternalConversation = {
  id: string;
  contact_name?: string | null;
  phone?: string | null;
  channel_name?: string | null;
};
type InternalChat = { id: string; name?: string | null; type: string };
type InternalUser = { id: string; name?: string | null };
type Target =
  | { kind: "external"; conversationId: string }
  | { kind: "internal"; chatId: string }
  | { kind: "user"; userId: string };
type Choice = { id: string; label: string; detail: string; target: Target };
export function ForwardMessageDialog({
  message,
  onClose,
}: {
  message: { id: string; conversationId: string; text?: string; type: string };
  onClose: () => void;
}) {
  const { session } = useSession();
  const [mode, setMode] = useState<"external" | "internal">("external");
  const [query, setQuery] = useState("");
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selected, setSelected] = useState<Choice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelected(null);
    setError("");
    setChoices([]);
    const timer = setTimeout(async () => {
      try {
        let items: Choice[];
        if (mode === "external") {
          const data = await apiGet(
            `/conversations?q=${encodeURIComponent(query.trim())}&limit=100`,
          );
          items = (data.conversations ?? [])
            .filter((c: ExternalConversation) => c.id !== message.conversationId)
            .map((c: ExternalConversation) => ({
              id: c.id,
              label: c.contact_name || c.phone || "Contato",
              detail: [c.phone, c.channel_name].filter(Boolean).join(" · "),
              target: { kind: "external", conversationId: c.id },
            }));
        } else {
          const [chats, users] = await Promise.all([
            apiGet("/internal-chat/list"),
            apiGet("/internal-chat/users"),
          ]);
          items = [
            ...(chats.chats ?? []).map((c: InternalChat) => ({
              id: `chat-${c.id}`,
              label: c.name || "Conversa interna",
              detail: c.type === "group" ? "Grupo interno" : "Conversa interna",
              target: { kind: "internal", chatId: c.id },
            })),
            ...(users.users ?? [])
              .filter((u: InternalUser) => u.id !== session.userId)
              .map((u: InternalUser) => ({
                id: `user-${u.id}`,
                label: u.name || "Atendente",
                detail: "Atendente da empresa",
                target: { kind: "user", userId: u.id },
              })),
          ];
          const q = query.trim().toLocaleLowerCase();
          items = items.filter((c) => `${c.label} ${c.detail}`.toLocaleLowerCase().includes(q));
        }
        if (!cancelled) setChoices(items);
      } catch (e) {
        if (!cancelled) setError(getApiErrorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, query, message.conversationId, session.userId]);
  async function submit() {
    if (!selected || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError("");
    try {
      await apiPost("/messages/forward", { messageId: message.id, target: selected.target });
      toast.success("Mensagem encaminhada.");
      onClose();
    } catch (e) {
      setError(getApiErrorMessage(e));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !inFlight.current) onClose();
      }}
    >
      <DialogContent
        className="max-w-lg"
        onEscapeKeyDown={(e) => {
          if (sending) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (sending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Encaminhar mensagem</DialogTitle>
          <DialogDescription>
            Uma cópia será enviada ao destino escolhido. A mensagem original permanece no histórico.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap break-words">
          {message.text?.slice(0, 220) || (message.type === "image" ? "Imagem" : "Documento")}
        </div>
        <div className="flex gap-2" aria-label="Tipo de destino">
          <button
            disabled={sending}
            aria-pressed={mode === "external"}
            className={`flex-1 rounded-md border p-2 ${mode === "external" ? "bg-whatsapp text-white" : ""}`}
            onClick={() => setMode("external")}
          >
            WhatsApp
          </button>
          <button
            disabled={sending}
            aria-pressed={mode === "internal"}
            className={`flex-1 rounded-md border p-2 ${mode === "internal" ? "bg-whatsapp text-white" : ""}`}
            onClick={() => setMode("internal")}
          >
            Atendente ou grupo interno
          </button>
        </div>
        <label className="text-sm">
          Buscar destinatário
          <input
            disabled={sending}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === "external" ? "Nome ou telefone" : "Nome do atendente ou grupo"}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2"
          />
        </label>
        <div
          className="max-h-56 overflow-y-auto space-y-1"
          aria-label="Destinatários"
          aria-busy={loading}
        >
          {loading ? (
            <p className="p-3 text-sm">Buscando destinatários…</p>
          ) : (
            choices.map((c) => (
              <button
                disabled={sending}
                key={c.id}
                aria-pressed={selected?.id === c.id}
                onClick={() => setSelected(c)}
                className={`block w-full rounded-md border px-3 py-2 text-left ${selected?.id === c.id ? "border-whatsapp bg-whatsapp/10" : ""}`}
              >
                <span className="block text-sm font-medium">{c.label}</span>
                <span className="text-xs text-muted-foreground">{c.detail}</span>
              </button>
            ))
          )}
          {!loading && !choices.length && !error && (
            <p className="p-3 text-sm">Nenhum destinatário encontrado.</p>
          )}
        </div>
        {mode === "external" && (
          <p className="text-xs text-muted-foreground">
            O canal aparece abaixo do contato. O envio respeita a janela de atendimento do WhatsApp.
            Localizações são encaminhadas como um link do mapa.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button disabled={sending} className="rounded-md border px-3 py-2" onClick={onClose}>
            Cancelar
          </button>
          <button
            disabled={!selected || sending || loading}
            onClick={() => void submit()}
            className="rounded-md bg-whatsapp px-3 py-2 text-white disabled:opacity-50"
          >
            {sending
              ? "Encaminhando…"
              : selected
                ? `Encaminhar para ${selected.label}`
                : "Escolha o destinatário"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
