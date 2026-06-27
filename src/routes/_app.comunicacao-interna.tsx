// Comunicação Interna — integrada às APIs reais (/api/auth/* + /api/internal-chat/*).
// Não usa Supabase, não usa localStorage como banco. Mantém layout split (lista + chat).
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { MessageSquare, Send, Loader2, Users, AlertTriangle, Plus, X } from "lucide-react";

export const Route = createFileRoute("/_app/comunicacao-interna")({
  component: ComunicacaoInternaPage,
});

interface MeUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenant_id: string | null;
}

interface ChatRow {
  id: string;
  name: string;
  type: string;
  created_at: string;
  last_message: string | null;
  last_message_at: string | null;
  unread: number;
}

interface MessageRow {
  id: string;
  chat_id: string;
  sender_id: string;
  sender_name: string;
  body: string;
  created_at: string;
}

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}
async function jpost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { const j = await r.json(); msg = (j as { error?: string }).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

function formatTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function ComunicacaoInternaPage() {
  const [me, setMe] = useState<MeUser | null | undefined>(undefined); // undefined = loading
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [chatsLoading, setChatsLoading] = useState(true);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [msgsError, setMsgsError] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  // Modal "Nova conversa"
  const [newOpen, setNewOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  async function reloadChats() {
    try {
      const r = await jget<{ chats: ChatRow[] }>("/api/internal-chat/list");
      setChats(r.chats);
    } catch { /* ignore */ }
  }

  async function handleCreated(chatId: string) {
    setNewOpen(false);
    await reloadChats();
    setActiveId(chatId);
  }

  // 1) Auth
  useEffect(() => {
    let cancel = false;
    jget<{ user: MeUser | null }>("/api/auth/me")
      .then((r) => { if (!cancel) setMe(r.user); })
      .catch(() => { if (!cancel) setMe(null); });
    return () => { cancel = true; };
  }, []);

  // 2) Lista de conversas + polling 5s
  useEffect(() => {
    if (!me) return;
    let cancel = false;
    const load = async () => {
      try {
        const r = await jget<{ chats: ChatRow[] }>("/api/internal-chat/list");
        if (cancel) return;
        setChats(r.chats);
        setChatsError(null);
      } catch (e) {
        if (!cancel) setChatsError((e as Error).message);
      } finally {
        if (!cancel) setChatsLoading(false);
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => { cancel = true; clearInterval(id); };
  }, [me]);

  // 3) Mensagens da conversa ativa + polling 5s
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    let cancel = false;
    setMsgsLoading(true);
    const load = async () => {
      try {
        const r = await jget<{ messages: MessageRow[] }>(`/api/internal-chat/messages?chatId=${encodeURIComponent(activeId)}`);
        if (cancel) return;
        // merge por id, sem duplicar
        setMessages((prev) => {
          const map = new Map<string, MessageRow>();
          for (const m of prev) map.set(m.id, m);
          for (const m of r.messages) map.set(m.id, m);
          return Array.from(map.values()).sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
          );
        });
        setMsgsError(null);
      } catch (e) {
        if (!cancel) setMsgsError((e as Error).message);
      } finally {
        if (!cancel) setMsgsLoading(false);
      }
    };
    setMessages([]); // limpa ao trocar de chat
    load();
    const id = setInterval(load, 5000);
    return () => { cancel = true; clearInterval(id); };
  }, [activeId]);

  // auto scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeId]);

  const active = useMemo(() => chats.find((c) => c.id === activeId) ?? null, [chats, activeId]);

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    try {
      const r = await jpost<{ message: MessageRow }>("/api/internal-chat/send", {
        chatId: activeId,
        body: text,
      });
      setDraft("");
      // injeta otimista
      setMessages((prev) => {
        if (prev.some((m) => m.id === r.message.id)) return prev;
        return [...prev, { ...r.message, sender_name: me?.name ?? "Eu" }];
      });
    } catch (e) {
      setMsgsError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  // ---- Estados ----
  if (me === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando…
      </div>
    );
  }

  if (me === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-500" />
          <h2 className="mb-2 text-lg font-semibold">Você não está autenticado</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Faça login (ou cadastre-se temporariamente) para usar a Comunicação Interna.
          </p>
          <div className="flex justify-center gap-2">
            <Link to="/login" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Entrar</Link>
            <Link to="/register" className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent">Cadastrar</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Lista de conversas */}
      <aside className="flex w-full flex-col border-b border-border bg-card lg:w-80 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <MessageSquare className="h-4 w-4" /> Comunicação Interna
            </h2>
            <p className="truncate text-xs text-muted-foreground">Olá, {me.name}</p>
          </div>
          <button
            type="button"
            onClick={() => setNewOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> Nova
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {chatsLoading && chats.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">Carregando conversas…</div>
          ) : chatsError ? (
            <div className="p-4 text-sm text-destructive">Erro ao carregar: {chatsError}</div>
          ) : chats.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Users className="mx-auto mb-2 h-6 w-6 opacity-50" />
              Nenhuma conversa ainda.
            </div>
          ) : (
            <ul>
              {chats.map((c) => {
                const isActive = c.id === activeId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(c.id)}
                      className={`flex w-full items-start gap-3 border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-accent ${isActive ? "bg-accent" : ""}`}
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {c.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{c.name}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(c.last_message_at)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-xs text-muted-foreground">
                            {c.last_message ?? "Sem mensagens"}
                          </p>
                          {c.unread > 0 && (
                            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                              {c.unread}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Painel da conversa */}
      <section className="flex min-h-0 flex-1 flex-col bg-background">
        {!active ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Selecione uma conversa para começar.
          </div>
        ) : (
          <>
            <header className="border-b border-border bg-card px-4 py-3">
              <h3 className="text-sm font-semibold">{active.name}</h3>
              <p className="text-[11px] text-muted-foreground">{active.type === "direct" ? "Conversa direta" : "Grupo"}</p>
            </header>

            <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
              {msgsLoading && messages.length === 0 ? (
                <div className="text-sm text-muted-foreground">Carregando mensagens…</div>
              ) : msgsError ? (
                <div className="text-sm text-destructive">Erro: {msgsError}</div>
              ) : messages.length === 0 ? (
                <div className="text-sm text-muted-foreground">Nenhuma mensagem ainda. Diga oi 👋</div>
              ) : (
                messages.map((m) => {
                  const mine = m.sender_id === me.id;
                  return (
                    <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${mine ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                        {!mine && <div className="mb-0.5 text-[10px] font-medium opacity-80">{m.sender_name}</div>}
                        <div className="whitespace-pre-wrap break-words">{m.body}</div>
                        <div className={`mt-1 text-right text-[10px] ${mine ? "opacity-80" : "text-muted-foreground"}`}>
                          {formatTime(m.created_at)}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <form onSubmit={onSend} className="flex gap-2 border-t border-border bg-card p-3">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Digite uma mensagem…"
                className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                disabled={sending}
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Enviar
              </button>
            </form>
          </>
        )}
      </section>

      {newOpen && (
        <NewChatModal
          currentUserId={me.id}
          onClose={() => setNewOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

interface TenantUser { id: string; name: string; email: string; role: string }

function NewChatModal({
  currentUserId,
  onClose,
  onCreated,
}: {
  currentUserId: string;
  onClose: () => void;
  onCreated: (chatId: string) => void;
}) {
  const [type, setType] = useState<"direct" | "group">("direct");
  const [title, setTitle] = useState("");
  const [users, setUsers] = useState<TenantUser[] | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    jget<{ users: TenantUser[] }>("/api/internal-chat/users")
      .then((r) => { if (!cancel) setUsers(r.users.filter((u) => u.id !== currentUserId)); })
      .catch((e) => { if (!cancel) setError((e as Error).message); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [currentUserId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        if (type === "direct") next.clear();
        next.add(id);
      }
      return next;
    });
  }

  function changeType(t: "direct" | "group") {
    setType(t);
    if (t === "direct" && selected.size > 1) {
      const first = Array.from(selected)[0];
      setSelected(new Set([first]));
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (selected.size === 0) { setError("Selecione ao menos um usuário."); return; }
    if (type === "direct" && selected.size !== 1) { setError("Conversa direta requer exatamente 1 usuário."); return; }
    if (type === "group" && !title.trim()) { setError("Informe o nome do grupo."); return; }
    setSubmitting(true);
    try {
      const r = await fetch("/api/internal-chat/create", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          title: type === "group" ? title.trim() : undefined,
          memberIds: Array.from(selected),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      onCreated((j as { chat: { id: string } }).chat.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const filtered = (users ?? []).filter((u) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Nova conversa</h3>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto p-4">
          <div className="flex gap-2">
            <button type="button" onClick={() => changeType("direct")}
              className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium ${type === "direct" ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent"}`}>
              Conversa individual
            </button>
            <button type="button" onClick={() => changeType("group")}
              className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium ${type === "group" ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent"}`}>
              Grupo
            </button>
          </div>

          {type === "group" && (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Nome do grupo"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              maxLength={120}
            />
          )}

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar usuários…"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />

          <div className="max-h-64 overflow-y-auto rounded-md border border-border">
            {loading ? (
              <div className="p-4 text-center text-xs text-muted-foreground">Carregando usuários…</div>
            ) : filtered.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">Nenhum usuário encontrado.</div>
            ) : (
              <ul>
                {filtered.map((u) => {
                  const checked = selected.has(u.id);
                  return (
                    <li key={u.id}>
                      <button type="button" onClick={() => toggle(u.id)}
                        className={`flex w-full items-center gap-3 border-b border-border/60 px-3 py-2 text-left text-sm hover:bg-accent ${checked ? "bg-accent" : ""}`}>
                        <input
                          type={type === "direct" ? "radio" : "checkbox"}
                          checked={checked}
                          readOnly
                          className="pointer-events-none"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{u.name}</div>
                          <div className="truncate text-[11px] text-muted-foreground">{u.email}</div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-accent">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={submitting || selected.size === 0}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Criar
          </button>
        </div>
      </form>
    </div>
  );
}
