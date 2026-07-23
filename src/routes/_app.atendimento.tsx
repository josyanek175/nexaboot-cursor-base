import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Search, Paperclip, Send, Smile, Mic, MoreVertical, Phone, Video,
  Check, CheckCheck, AlertCircle, FileText, Download, Play, Tag, X,
  UserPlus, ArrowRightLeft, CheckCircle, RotateCcw, StickyNote, History,
  Filter, PanelRightClose, PanelRightOpen, Image as ImageIcon, FileVideo, FileAudio,
  Wifi, WifiOff, ContactRound,
} from "lucide-react";
import { subscribeToConversation } from "@/lib/realtime";
import { useSession } from "@/lib/session";
import { canSeeAllConversations, inTenantScope } from "@/lib/permissions";
import { pushAudit } from "@/lib/audit-log";
import { apiGet, apiPost, apiPostForm, getApiErrorMessage } from "@/lib/api";
import { ensureNotificationPermission, showBrowserNotification, playNotificationSound, isTabHidden } from "@/lib/notifications";
import { setUnread } from "@/lib/unread-store";
import {
  extractSharedContacts,
  hasContactPayload,
  isContactsArrayPayload,
  type SharedContact,
} from "@/lib/whatsapp-contact-message";
import { formatChannelPhoneForDisplay, formatPhoneDisplayLoose } from "@/lib/phone";
import {
  isLegacyMetaTemplatePlaceholder,
  renderMetaTemplateFromComponents,
} from "@/lib/meta-template-render";

// ───────── Tipos locais (dados 100% reais — sem mocks) ─────────
type Provider = "META" | "EVOLUTION" | "INTERNAL";
type ConversationStatus = "open" | "waiting" | "finished";
type MessageType =
  | "text"
  | "image"
  | "audio"
  | "document"
  | "video"
  | "internal"
  | "reaction"
  | "contact"
  | "contacts"
  | "system";
type MessageDirection = "in" | "out";
type MessageStatus = "sent" | "delivered" | "read" | "error";
type ChannelStatus = "connected" | "connecting" | "qrcode" | "disconnected" | "error";

interface Channel {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  provider: Provider;
  status: ChannelStatus;
}
interface Contact {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  email?: string;
  avatarColor: string;
}
interface AttUser {
  id: string;
  tenantId: string;
  name: string;
  email?: string;
  role: string;
  avatarColor: string;
}
interface Conversation {
  id: string;
  tenantId: string;
  channelId: string;
  contactId: string;
  status: ConversationStatus;
  unreadCount: number;
  assignedTo?: string;
  assignedUserName?: string;
  isMine?: boolean;
  lastMessageAt: string;
  tags: string[];
  campaignReplyCampaignId?: string;
  campaignReplyCampaignName?: string;
  campaignReplyText?: string;
  campaignReplyIntent?: string;
}
interface Message {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  type: MessageType;
  text?: string;
  mediaUrl?: string;
  mediaError?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  durationSeconds?: number;
  status: MessageStatus;
  createdAt: string;
  authorName?: string;
  isInternalNote?: boolean;
  thumbnailUrl?: string;
  reactionEmoji?: string;
  /** Contatos extraídos de contactMessage / contactsArrayMessage / vCard. */
  sharedContacts?: SharedContact[];
  /** Botões de template Meta (campanha), exibidos abaixo do corpo. */
  templateButtons?: string[];
}

// ───────── Utilitários de formatação ─────────
function formatTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const diff = (today.getTime() - d.getTime()) / 86_400_000;
  if (diff < 7) return d.toLocaleDateString("pt-BR", { weekday: "short" });
  return d.toLocaleDateString("pt-BR");
}
function formatBytes(b?: number): string {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(1)} MB`;
}
function phoneLabel(raw: string | null | undefined): string {
  return formatPhoneDisplayLoose(raw);
}
function channelFilterLabel(ch: Channel): string {
  const phone = ch.phone?.trim();
  return phone ? `${ch.name} (${phone})` : ch.name;
}

// ───────── Registros reais (preenchidos a partir das APIs) ─────────
// Começam vazios: nenhum dado fake. São populados por reloadConversations,
// reloadChannels e reloadUsers com dados do banco/Evolution.
const contacts: Contact[] = [];
const channels: Channel[] = [];
const users: AttUser[] = [];

function getContact(id: string): Contact {
  return (
    contacts.find((c) => c.id === id) ?? {
      id,
      tenantId: "",
      name: "",
      phone: "",
      avatarColor: "#64748b",
    }
  );
}
function getChannel(id: string): Channel {
  return (
    channels.find((c) => c.id === id) ?? {
      id,
      tenantId: "",
      name: "—",
      phone: "",
      provider: "EVOLUTION",
      status: "disconnected",
    }
  );
}
function getUser(id?: string): AttUser | undefined {
  return id ? users.find((u) => u.id === id) : undefined;
}

// ───────── Transformadores API → tipos locais ─────────
const PALETTE = ["#00a884", "#06cf9c", "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#ef4444", "#14b8a6"];
const colorFor = (seed: string) => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

/** Flags auxiliares vindas da API (não alteram o tipo Contact original). */
const groupContactIds = new Set<string>();
/** Mapeia conversationId → channel_name (instance name) recebido da API. */
const conversationInstanceName = new Map<string, string>();
/** Mapeia conversationId → telefone/JID a usar no envio (pode vir do contact). */
const conversationPhone = new Map<string, string>();
/** Debug temporário: por conversationId, último pushName/remoteJid observado. */
const conversationDebug = new Map<string, { pushName?: string; remoteJid?: string }>();

function mapApiStatus(s: unknown): ConversationStatus {
  if (s === "waiting" || s === "pending") return "waiting";
  if (s === "closed" || s === "finished" || s === "resolved") return "finished";
  return "open";
}
function mapApiProvider(t: unknown): Provider {
  if (t === "META") return "META";
  if (t === "INTERNAL") return "INTERNAL";
  return "EVOLUTION";
}
/** Insere contato/canal sintéticos nos mocks se ainda não existem (para getContact/getChannel). */
function upsertContactFromApi(c: any, tenantId: string) {
  const isGroup = c?.contact_type === "group";
  if (isGroup && c.contact_id) groupContactIds.add(c.contact_id);
  if (c?.id && c?.phone && !isGroup) conversationPhone.set(c.id, c.phone);
  if (c?.id && isGroup && (c.external_jid || c.phone)) {
    conversationPhone.set(c.id, c.external_jid || c.phone);
  }
  // Captura debug de nomes vindos da conversa
  if (c?.id) {
    const prev = conversationDebug.get(c.id) ?? {};
    conversationDebug.set(c.id, {
      pushName: c.push_name ?? c.pushName ?? prev.pushName,
      remoteJid: c.external_jid ?? c.remote_jid ?? c.remoteJid ?? prev.remoteJid,
    });
  }
  if (!c?.contact_id) return;
  // Prioridade de nome — nunca substituir nome válido por telefone.
  const phoneFmt = c.phone || c.external_jid || "";
  const displayName = isGroup
    ? (c.group_name || c.contact_name || c.external_jid || "Grupo")
    : (c.contact_name || c.push_name || c.notify_name || c.pushName || phoneFmt || "Contato");
  const existing = contacts.find((x) => x.id === c.contact_id);
  if (existing) {
    // Só atualiza se o atual estiver vazio ou for igual ao telefone (placeholder).
    const placeholder = !existing.name || existing.name === existing.phone;
    if (placeholder && displayName && displayName !== phoneFmt) {
      existing.name = displayName;
    }
    return;
  }
  contacts.push({
    id: c.contact_id,
    tenantId,
    name: displayName,
    phone: isGroup ? "" : phoneFmt,
    avatarColor: colorFor(c.contact_id),
  });
}

function upsertChannelFromApi(c: any, tenantId: string) {
  if (c?.id && c?.channel_name) conversationInstanceName.set(c.id, c.channel_name);
  if (!c?.whatsapp_channel_id || channels.some((x) => x.id === c.whatsapp_channel_id)) return;
  channels.push({
    id: c.whatsapp_channel_id,
    tenantId,
    name: c.channel_name || "Canal",
    phone: "",
    provider: mapApiProvider(c.channel_type),
    status: "connected",
  });
}

/** Mapeia status do banco para UI; Meta ACTIVE = operacional (não usa QR Evolution). */
function mapChannelStatus(s: unknown, channelType?: unknown): ChannelStatus {
  const type = String(channelType ?? "").toLowerCase();
  const v = String(s ?? "").toUpperCase();
  if (type === "meta") {
    if (v === "ACTIVE") return "connected";
    if (v === "PAUSED" || v === "PENDING_REVIEW") return "connecting";
    if (v === "ERROR" || v === "BLOCKED") return "error";
    if (v === "DISCONNECTED") return "disconnected";
  }
  const lower = v.toLowerCase();
  if (lower === "connected" || lower === "open") return "connected";
  if (lower === "connecting") return "connecting";
  if (lower.includes("qr")) return "qrcode";
  if (lower === "error") return "error";
  return "disconnected";
}

function isChannelOperational(channel: Channel): boolean {
  return channel.status === "connected";
}

/** Upsert de um canal real vindo de /api/evolution/channels (autoritativo). */
function upsertRealChannel(
  c: any,
  tenantId: string,
  metaById?: Map<string, { display_phone_number?: string | null }>,
): Channel {
  const provider: Provider =
    String(c?.channel_type).toLowerCase() === "meta" ? "META" : "EVOLUTION";
  const meta = metaById?.get(c.id);
  const channel: Channel = {
    id: c.id,
    tenantId,
    name: c.display_name || c.name || c.evolution_instance_name || "Canal",
    phone: formatChannelPhoneForDisplay({
      channelType: c.channel_type,
      displayPhoneNumber: meta?.display_phone_number ?? c.display_phone_number,
      phoneNumber: c.phone_number,
    }),
    provider,
    status: mapChannelStatus(c.status, c.channel_type),
  };
  const idx = channels.findIndex((x) => x.id === channel.id);
  if (idx >= 0) channels[idx] = { ...channels[idx], ...channel };
  else channels.push(channel);
  return channel;
}

/** Upsert de um atendente real vindo de /api/attendants. */
function upsertRealUser(u: any, tenantId: string): AttUser {
  const user: AttUser = {
    id: u.id,
    tenantId,
    name: u.name || u.email || "Usuário",
    email: u.email ?? undefined,
    role: String(u.role ?? "ATENDENTE"),
    avatarColor: colorFor(u.id),
  };
  const idx = users.findIndex((x) => x.id === user.id);
  if (idx >= 0) users[idx] = { ...users[idx], ...user };
  else users.push(user);
  return user;
}
function transformApiConversation(c: any, tenantId: string): Conversation {
  const assignedTo = c.assigned_user_id ?? undefined;
  const assignedUserName =
    c.assigned_user_name || c.assigned_user_email || undefined;
  return {
    id: c.id,
    tenantId,
    channelId: c.whatsapp_channel_id,
    contactId: c.contact_id,
    status: mapApiStatus(c.status),
    unreadCount: typeof c.unread_count === "number" ? c.unread_count : 0,
    assignedTo,
    assignedUserName: assignedTo ? assignedUserName : undefined,
    isMine: c.is_mine === true,
    lastMessageAt: c.last_message_at ?? new Date().toISOString(),
    tags: [],
    campaignReplyCampaignId: c.campaign_reply_campaign_id ?? undefined,
    campaignReplyCampaignName: c.campaign_reply_campaign_name ?? undefined,
    campaignReplyText: c.campaign_reply_text ?? undefined,
    campaignReplyIntent: c.campaign_reply_intent ?? undefined,
  };
}

function responsibleLabel(conv: Conversation, currentUserId?: string): string {
  if (!conv.assignedTo) return "Sem responsável";
  if (conv.isMine || (currentUserId && conv.assignedTo === currentUserId)) {
    return "Responsável: Você";
  }
  const name = conv.assignedUserName || getUser(conv.assignedTo)?.name;
  return name ? `Responsável: ${name}` : "Responsável: Atendente";
}
function transformApiMessage(m: any, conversationId: string): Message {
  const mediaType = m.media_type ?? m.mediaType ?? undefined;
  const rawType = String(mediaType || m.message_type || m.type || "text").toLowerCase();

  const fromMe = m.from_me === true;
  const rawDir = (m.direction || "").toString().toLowerCase();
  const direction: "in" | "out" =
    fromMe || rawDir === "outbound" || rawDir === "out" || m.sender === "agent" ? "out" : "in";

  const status: MessageStatus =
    m.status === "read" || m.status === "delivered" || m.status === "sent" || m.status === "error"
      ? m.status
      : "delivered";

  const text = m.message_text ?? m.text ?? m.body ?? m.content ?? m.message ?? undefined;
  const caption = m.media_caption ?? undefined;

  const rp = m.raw_payload ?? m.rawPayload;
  const rpObj = typeof rp === "object" && rp ? (rp as any) : {};
  const dataObj = rpObj.data ?? {};

  let templateButtons: string[] | undefined;
  let displayText = text != null ? String(text) : "";
  const metaTpl = rpObj.meta_template;
  if (metaTpl && typeof metaTpl === "object") {
    const mt = metaTpl as Record<string, unknown>;
    const params = Array.isArray(mt.body_parameters)
      ? mt.body_parameters.map((p) => String(p))
      : [];
    const components = mt.template_components;
    if (Array.isArray(mt.template_buttons) && mt.template_buttons.length > 0) {
      templateButtons = mt.template_buttons.map((b) => String(b));
    }
    if (components && (isLegacyMetaTemplatePlaceholder(displayText) || !displayText.trim())) {
      const rendered = renderMetaTemplateFromComponents({ components, parameters: params });
      if (rendered.body.trim()) displayText = rendered.body;
      if (!templateButtons?.length && rendered.buttons.length > 0) {
        templateButtons = rendered.buttons;
      }
    } else if (!templateButtons?.length && components) {
      const rendered = renderMetaTemplateFromComponents({ components, parameters: params });
      if (rendered.buttons.length > 0) templateButtons = rendered.buttons;
    }
  }

  // Contatos: tipo novo (contact/contacts) ou legado unsupported com vCard no raw_payload.
  const textStr = displayText;
  const looksUnsupported =
    /\[mensagem não suportada\]/i.test(textStr) ||
    rawType === "unsupported" ||
    rawType === "unknown";
  const fromPayload = hasContactPayload(rp);
  let type: MessageType =
    rawType === "image" ||
    rawType === "audio" ||
    rawType === "video" ||
    rawType === "document" ||
    rawType === "internal" ||
    rawType === "reaction" ||
    rawType === "contact" ||
    rawType === "contacts" ||
    rawType === "system"
      ? (rawType as MessageType)
      : "text";
  if (String(m.direction || "").toLowerCase() === "system") {
    type = "system";
  }
  let sharedContacts: SharedContact[] | undefined;

  if (type === "contact" || type === "contacts") {
    sharedContacts = extractSharedContacts(rp);
  } else if (fromPayload) {
    // Legado: message_type text/unsupported com contactMessage no raw_payload.
    type = isContactsArrayPayload(rp) ? "contacts" : "contact";
    sharedContacts = extractSharedContacts(rp);
  } else if (looksUnsupported && /BEGIN:VCARD/i.test(textStr)) {
    type = "contact";
    sharedContacts = extractSharedContacts(textStr);
  } else if (/contato compartilhado/i.test(textStr) && !mediaType) {
    // Texto já normalizado no banco, sem tipo contact.
    type = /contatos compartilhados/i.test(textStr) ? "contacts" : "contact";
    sharedContacts = extractSharedContacts(rp);
  }

  const placeholder =
    type === "image" ? "[imagem]" :
    type === "audio" ? "[áudio]" :
    type === "video" ? "[vídeo]" :
    type === "document" ? "[documento]" :
    type === "contact" ? "Contato compartilhado" :
    type === "contacts" ? "Contatos compartilhados" :
    undefined;
  const finalText =
    type === "contact" || type === "contacts"
      ? (textStr && !/\[mensagem não suportada\]/i.test(textStr) ? textStr : placeholder)
      : (textStr.trim().length > 0) ? textStr :
        (caption && String(caption).trim().length > 0) ? caption :
        placeholder;

  const mimeType = m.media_mimetype ?? m.mime_type ?? m.mimeType ?? undefined;
  const mediaUrl: string | undefined = m.media_url ?? m.mediaUrl ?? undefined;
  const mediaError: string | undefined = m.media_error ?? m.mediaError ?? undefined;

  // Miniatura base64 (jpegThumbnail) quando presente no payload.
  const thumbB64 =
    dataObj?.message?.imageMessage?.jpegThumbnail ??
    dataObj?.message?.videoMessage?.jpegThumbnail;
  const thumbnailUrl = typeof thumbB64 === "string" && thumbB64.length > 50
    ? `data:image/jpeg;base64,${thumbB64}`
    : undefined;

  return {
    id: m.id ?? m.external_message_id ?? m.externalMessageId ?? `${conversationId}-${Math.random()}`,
    conversationId,
    direction,
    type,
    text: finalText,
    mediaUrl,
    fileName: m.media_filename ?? m.file_name ?? m.fileName ?? undefined,
    mimeType,
    fileSize: m.media_size ?? m.file_size ?? m.fileSize ?? undefined,
    durationSeconds: m.media_duration ?? m.duration_seconds ?? m.durationSeconds ?? undefined,
    status,
    createdAt: m.created_at ?? m.createdAt ?? new Date().toISOString(),
    authorName: m.author_name ?? m.authorName ?? m.sent_by_name ?? undefined,
    thumbnailUrl,
    mediaError,
    reactionEmoji: m.reaction_emoji ?? m.reactionEmoji ?? undefined,
    sharedContacts,
    templateButtons,
  };
}

export const Route = createFileRoute("/_app/atendimento")({
  component: AtendimentoPage,
  head: () => ({ meta: [{ title: "Atendimento — NexaBoot" }] }),
});

// ───────── Tipos auxiliares ─────────
type Status = "all" | ConversationStatus;
interface LogEntry {
  id: string;
  conversationId: string;
  at: string;
  text: string;
  author: string;
}

const statusFilters: { value: Status; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "open", label: "Abertas" },
  { value: "waiting", label: "Aguardando" },
  { value: "finished", label: "Finalizadas" },
];

// ───────── Página ─────────
function AtendimentoPage() {
  const { session, user, tenant } = useSession();
  const actor = { id: session.userId, role: session.role, tenantId: session.tenantId };

  const [convs, setConvs] = useState<Conversation[]>([]);
  const [msgs, setMsgs] = useState<Record<string, Message[]>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  // Canais e atendentes reais (DB/Evolution) usados nos filtros e ações.
  const [channelList, setChannelList] = useState<Channel[]>([]);
  const [userList, setUserList] = useState<AttUser[]>([]);

  const [loadingConvs, setLoadingConvs] = useState(true);
  const [convsError, setConvsError] = useState<string | null>(null);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [msgsError, setMsgsError] = useState<string | null>(null);

  const initialConversationId =
    typeof window !== "undefined"
      ? (new URLSearchParams(window.location.search).get("c") ?? "")
      : "";
  const [selectedId, setSelectedId] = useState<string>(initialConversationId);
  const [statusFilter, setStatusFilter] = useState<Status>("all");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "groups" | "individuals">("individuals");
  const [search, setSearch] = useState("");
  const [showDetails, setShowDetails] = useState(true);
  const [mobileView, setMobileView] = useState<"list" | "chat">(
    initialConversationId ? "chat" : "list",
  );
  const [draft, setDraft] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  // Envio real de mídia (imagem/áudio) via input de arquivo escondido.
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const mediaKindRef = useRef<"image" | "audio">("image");
  const [sendingMedia, setSendingMedia] = useState(false);
  // Busca de contatos reais (mesmo sem conversa) para iniciar atendimento.
  const [contactResults, setContactResults] = useState<Contact[]>([]);
  const [searchingContacts, setSearchingContacts] = useState(false);
  const [startingContactId, setStartingContactId] = useState<string>("");

  // Snapshot anterior para detectar mensagens novas no polling.
  const prevConvsRef = useRef<Map<string, string>>(new Map());
  // Notificações de transferência: evita toast repetido no polling.
  const seenAttendanceNotifs = useRef<Set<string>>(new Set());
  const attendanceNotifsBootstrapped = useRef(false);
  const selectedIdRef = useRef<string>("");
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  // Scroll automático para o fim do chat ao chegar/enviar mensagem.
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Conversas com destaque temporário (após receber nova mensagem).
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());

  // Solicita permissão de notificação ao abrir a tela.
  useEffect(() => { ensureNotificationPermission(); }, []);

  // Carrega conversas via REST.
  const reloadConversations = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setLoadingConvs(true);
      setConvsError(null);
    }
    try {
      const data = await apiGet("/conversations");
      const list: any[] = Array.isArray(data?.conversations)
        ? data.conversations
        : Array.isArray(data)
        ? data
        : [];
      list.forEach((c) => {
        upsertContactFromApi(c, session.tenantId);
        upsertChannelFromApi(c, session.tenantId);
      });
      const mapped = list
        .filter((c) => c && c.id && c.contact_id && c.whatsapp_channel_id)
        .map((c) => transformApiConversation(c, session.tenantId));

      // Detecta novas mensagens comparando lastMessageAt.
      const prev = prevConvsRef.current;
      const nextMap = new Map<string, string>();
      const newlyActive: Conversation[] = [];
      mapped.forEach((c) => {
        nextMap.set(c.id, c.lastMessageAt);
        const before = prev.get(c.id);
        if (before && c.lastMessageAt > before) newlyActive.push(c);
      });
      prevConvsRef.current = nextMap;

      if (prev.size > 0 && newlyActive.length > 0) {
        playNotificationSound();
        newlyActive.forEach((c) => {
          const ct = getContact(c.contactId);
          const isOpen = c.id === selectedIdRef.current && !isTabHidden();
          if (!isOpen) {
            showBrowserNotification(`Nova mensagem · ${ct?.name ?? "Contato"}`, "Toque para abrir a conversa", { tag: `wa-${c.id}` });
            setHighlighted((h) => new Set(h).add(c.id));
            setTimeout(() => {
              setHighlighted((h) => { const n = new Set(h); n.delete(c.id); return n; });
            }, 4000);
          }
        });
      }

      setConvs(mapped);
    } catch (e) {
      if (!opts?.silent) {
        setConvsError(e instanceof Error ? e.message : "Falha ao carregar conversas");
        setConvs([]);
      }
    } finally {
      if (!opts?.silent) setLoadingConvs(false);
    }
  };
  useEffect(() => {
    reloadConversations();
    // Polling de conversas a cada 5s.
    const id = setInterval(() => reloadConversations({ silent: true }), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tenantId]);

  // Carrega canais reais conectados/cadastrados (Evolution) para o filtro.
  const reloadChannels = async () => {
    try {
      const [data, metaData] = await Promise.all([
        apiGet("/evolution/channels"),
        apiGet("/meta/channels").catch(() => ({ channels: [] as { id: string; display_phone_number?: string | null }[] })),
      ]);
      const metaById = new Map(
        (metaData.channels ?? []).map((m: { id: string; display_phone_number?: string | null }) => [m.id, m]),
      );
      const list: any[] = Array.isArray(data?.channels) ? data.channels : [];
      const mapped = list.map((c) => upsertRealChannel(c, session.tenantId, metaById));
      setChannelList(mapped);
    } catch {
      // mantém canais já conhecidos (vindos das conversas); silencioso
    }
  };
  // Carrega atendentes reais do tenant para filtro/atribuição/transferência.
  // Usa /api/attendants (dedicado ao Atendimento), não /api/users (admin-only).
  const reloadUsers = async () => {
    try {
      const data = await apiGet("/attendants");
      const list: any[] = Array.isArray(data?.attendants) ? data.attendants : [];
      const mapped = list.map((u) => upsertRealUser(u, session.tenantId));
      setUserList(mapped);
    } catch {
      // sem atendentes carregados; ações de atribuição ficam indisponíveis
    }
  };
  useEffect(() => {
    reloadChannels();
    reloadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tenantId]);

  /** Carrega mensagens, mesclando por id para não duplicar nem perder otimistas. */
  const reloadMessages = async (convId: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setLoadingMsgs(true);
      setMsgsError(null);
    }
    try {
      const data = await apiGet(`/conversations/${encodeURIComponent(convId)}/messages`);
      if (!opts?.silent) console.log("mensagens retornadas", data);
      const list: any[] = Array.isArray(data?.messages)
        ? data.messages
        : Array.isArray(data)
        ? data
        : [];
      const incoming = list.map((m) => transformApiMessage(m, convId));
      setMsgs((prev) => {
        const existing = prev[convId] ?? [];
        const incomingIds = new Set(incoming.map((m) => m.id));
        // Mantém otimistas locais ainda não retornados pela API; remove os já
        // confirmados (mesma direção + mesmo texto numa janela de 2 min).
        const isLikelyConfirmed = (opt: Message) =>
          incoming.some(
            (m) =>
              m.direction === opt.direction &&
              m.type === opt.type &&
              (m.text ?? "") === (opt.text ?? "") &&
              Math.abs(new Date(m.createdAt).getTime() - new Date(opt.createdAt).getTime()) < 120_000,
          );
        const keptOptimistic = existing.filter(
          (m) => m.id.startsWith("m-") && !incomingIds.has(m.id) && !isLikelyConfirmed(m),
        );
        // Dedupe final por id (último vence).
        const byId = new Map<string, Message>();
        [...incoming, ...keptOptimistic].forEach((m) => byId.set(m.id, m));
        const merged = Array.from(byId.values()).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        return { ...prev, [convId]: merged };
      });
    } catch (e) {
      if (!opts?.silent) {
        setMsgsError(e instanceof Error ? e.message : "Falha ao carregar mensagens");
        setMsgs((prev) => ({ ...prev, [convId]: prev[convId] ?? [] }));
      }
    } finally {
      if (!opts?.silent) setLoadingMsgs(false);
    }
  };

  // Carrega mensagens da conversa selecionada via REST + polling 3s.
  useEffect(() => {
    if (!selectedId) return;
    console.log("conversation selecionada", selectedId);
    reloadMessages(selectedId);
    const id = setInterval(() => reloadMessages(selectedId, { silent: true }), 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Assumir atendimento via REST: POST /conversations/{id}/assume
  const assumeSelf = async () => {
    if (!selected) return;
    try {
      const res = await apiPost(`/conversations/${encodeURIComponent(selected.id)}/assume`, {});
      patchConv(selected.id, {
        assignedTo: res.assigned_user_id ?? actor.id,
        assignedUserName: res.assigned_user_name ?? user.name,
        isMine: true,
        status: "open",
      });
      upsertRealUser(
        {
          id: res.assigned_user_id ?? actor.id,
          name: res.assigned_user_name ?? user.name,
          email: res.assigned_user_email,
          role: session.role,
        },
        session.tenantId,
      );
      pushAudit({
        tenantId: selected.tenantId, actorId: actor.id, actorName: user.name,
        targetType: "conversation", targetId: selected.id,
        action: "conversation.assign", result: "success", reason: "assume (api)",
      });
      log(selected.id, `${user.name} assumiu o atendimento`);
      toast.success("Atendimento assumido");
      await reloadConversations({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao assumir atendimento");
    }
  };

  // Polling de notificações de transferência (a cada 12s).
  useEffect(() => {
    let cancelled = false;
    async function pollAttendanceNotifications() {
      try {
        const data = await apiGet("/attendance/notifications?unread=1");
        if (cancelled) return;
        const list: any[] = Array.isArray(data?.notifications) ? data.notifications : [];
        if (!attendanceNotifsBootstrapped.current) {
          for (const n of list) {
            if (n?.id) seenAttendanceNotifs.current.add(String(n.id));
          }
          attendanceNotifsBootstrapped.current = true;
          return;
        }
        for (const n of list) {
          const id = String(n?.id ?? "");
          if (!id || seenAttendanceNotifs.current.has(id)) continue;
          seenAttendanceNotifs.current.add(id);
          const convId = n.conversation_id as string | undefined;
          toast.info(n.title || "Você recebeu um atendimento", {
            description: n.body || undefined,
            action: convId
              ? {
                  label: "Abrir",
                  onClick: () => {
                    setSelectedId(convId);
                    setMobileView("chat");
                    apiPost("/attendance/notifications", { conversationId: convId }).catch(() => {});
                    reloadConversations({ silent: true });
                  },
                }
              : undefined,
          });
          // Atualiza lista para refletir a conversa transferida.
          reloadConversations({ silent: true });
        }
      } catch {
        // silencioso — não interrompe o atendimento
      }
    }
    pollAttendanceNotifications();
    const id = setInterval(pollAttendanceNotifications, 12_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.userId]);

  // Ao abrir uma conversa, marca notificações dela como lidas.
  useEffect(() => {
    if (!selectedId) return;
    apiPost("/attendance/notifications", { conversationId: selectedId }).catch(() => {});
  }, [selectedId]);

  // Preparação para Realtime (stub) — apenas demonstra ciclo de vida.
  useEffect(() => {
    if (!selectedId) return;
    return subscribeToConversation(selectedId, () => {});
  }, [selectedId]);

  // Canais e atendentes vêm das APIs reais (estado), não de mocks.
  const tenantChannels = channelList;
  const tenantUsers = userList;

  const filtered = useMemo(() => {
    // Fase 1 Evolution: dados reais vêm do banco principal (single-company).
    // Filtros de tenant/permissão/telefone (baseados em mocks) ficam desligados
    // aqui para não esconder conversas reais; mantemos status/canal/tipo/busca.
    return convs
      .filter((c) => statusFilter === "all" || c.status === statusFilter)
      .filter((c) => channelFilter === "all" || c.channelId === channelFilter)
      .filter((c) => {
        if (typeFilter === "all") return true;
        const isGroup = groupContactIds.has(c.contactId);
        return typeFilter === "groups" ? isGroup : !isGroup;
      })
      .filter((c) =>
        assigneeFilter === "all"
          ? true
          : assigneeFilter === "unassigned"
          ? !c.assignedTo
          : c.assignedTo === assigneeFilter,
      )
      .filter((c) => {
        if (!search) return true;
        const ct = getContact(c.contactId);
        if (!ct) return false;
        const s = search.toLowerCase();
        if ((ct.name || "").toLowerCase().includes(s) || (ct.phone || "").includes(s)) return true;
        return (msgs[c.id] ?? []).some((m) => m.text?.toLowerCase().includes(s));
      })
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));

  }, [convs, msgs, statusFilter, channelFilter, assigneeFilter, typeFilter, search]);

  // Busca contatos reais (mesmo sem conversa) em /api/contacts?q= ao digitar.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setContactResults([]);
      setSearchingContacts(false);
      return;
    }
    let cancelled = false;
    setSearchingContacts(true);
    const t = setTimeout(async () => {
      try {
        const data = await apiGet(`/contacts?q=${encodeURIComponent(q)}`);
        const list: any[] = Array.isArray(data?.contacts) ? data.contacts : [];
        if (cancelled) return;
        setContactResults(
          list.map((c) => ({
            id: c.id,
            tenantId: session.tenantId,
            name: c.name || c.phone || "Contato",
            phone: c.phone || "",
            email: c.email ?? undefined,
            avatarColor: c.avatar_color || colorFor(String(c.phone || c.id)),
          })),
        );
      } catch {
        if (!cancelled) setContactResults([]);
      } finally {
        if (!cancelled) setSearchingContacts(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, session.tenantId]);

  // Contatos da busca sem conversa no canal alvo.
  // Contato é único por empresa+telefone; conversa é por (contact_id, channel_id).
  // Não esconder o telefone só porque já existe conversa em outro canal.
  const contactsWithoutConversation = useMemo(() => {
    if (!search.trim()) return [];

    return contactResults.filter((ct) => {
      const channelsWithConv = new Set(
        convs.filter((c) => c.contactId === ct.id).map((c) => c.channelId),
      );

      // Canal específico: só esconde se já há conversa NAQUELE canal.
      if (channelFilter !== "all") {
        return !channelsWithConv.has(channelFilter);
      }

      // Filtro "todos": mostra se falta conversa em pelo menos um canal.
      if (tenantChannels.length === 0) return channelsWithConv.size === 0;
      return tenantChannels.some((ch) => !channelsWithConv.has(ch.id));
    });
  }, [contactResults, convs, search, channelFilter, tenantChannels]);

  /** Resolve o canal real para iniciar uma conversa nova (por contato + canal). */
  function resolveStartChannelId(ct?: Contact): string | null {
    if (channelFilter !== "all") return channelFilter;
    if (tenantChannels.length === 1) return tenantChannels[0].id;

    // Com filtro "todos", preferir um canal em que o contato ainda não tem conversa.
    if (ct) {
      const channelsWithConv = new Set(
        convs.filter((c) => c.contactId === ct.id).map((c) => c.channelId),
      );
      const missing = tenantChannels.filter((ch) => !channelsWithConv.has(ch.id));
      if (missing.length === 1) return missing[0].id;
    }
    return null;
  }

  /** Abre/cria conversa real para o contato no canal selecionado (ou no único sem conversa). */
  async function startConversationWithContact(ct: Contact) {
    if (tenantChannels.length === 0) {
      toast.error("Nenhum canal real disponível. Conecte um canal em Canais.");
      return;
    }
    const channelId = resolveStartChannelId(ct);
    if (!channelId) {
      toast.info("Selecione um canal no filtro para iniciar a conversa neste canal.");
      return;
    }
    setStartingContactId(ct.id);
    try {
      const res = await apiPost("/conversations/start", { contactId: ct.id, channelId });
      const convId: string | undefined = res?.conversationId;
      if (!convId) throw new Error("resposta inválida do servidor");
      // Registra o contato localmente para getContact resolver de imediato.
      if (!contacts.find((x) => x.id === ct.id)) contacts.push(ct);
      await reloadConversations({ silent: true });
      setSelectedId(convId);
      setMobileView("chat");
      setSearch("");
      setContactResults([]);
      toast.success(res?.created ? "Conversa iniciada" : "Conversa aberta");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao iniciar conversa");
    } finally {
      setStartingContactId("");
    }
  }

  // Garante que a conversa selecionada seja sempre uma que o usuário pode ver.
  useEffect(() => {
    if (filtered.length === 0) return;
    if (!filtered.some((c) => c.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  // Zera unread da conversa selecionada (local + servidor, best-effort).
  useEffect(() => {
    if (!selectedId) return;
    setConvs((prev) => prev.map((c) => (c.id === selectedId ? { ...c, unreadCount: 0 } : c)));
    apiPost(`/conversations/${encodeURIComponent(selectedId)}/read`, {}).catch(() => {
      // endpoint pode não existir em todos os backends; ignorar silenciosamente
    });
  }, [selectedId]);


  // Atualiza badge global (sidebar) com total de não-lidas do tenant ativo.
  useEffect(() => {
    const total = filtered.reduce((acc, c) => acc + (c.id === selectedId ? 0 : c.unreadCount || 0), 0);
    setUnread("atendimento", total);
  }, [filtered, selectedId]);

  const selected = convs.find((c) => c.id === selectedId) ?? filtered[0];
  const messages = selected ? msgs[selected.id] ?? [] : [];
  const convLogs = useMemo(
    () => logs.filter((l) => l.conversationId === selected?.id).slice().reverse(),
    [logs, selected],
  );

  // Auto-scroll para o fim ao chegar/enviar mensagem na conversa aberta.
  useEffect(() => {
    if (!selected) return;
    const el = messagesScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selected?.id, messages.length]);

  // ───────── Mutadores ─────────
  function log(conversationId: string, text: string) {
    setLogs((prev) => [
      ...prev,
      { id: `lg-${Date.now()}-${Math.random()}`, conversationId, at: new Date().toISOString(), text, author: user.name },
    ]);
  }
  function patchConv(id: string, patch: Partial<Conversation>) {
    setConvs((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function appendMsg(conversationId: string, m: Message) {
    setMsgs((prev) => ({ ...prev, [conversationId]: [...(prev[conversationId] ?? []), m] }));
    patchConv(conversationId, { lastMessageAt: m.createdAt, unreadCount: 0 });
  }
  function patchMsg(conversationId: string, id: string, patch: Partial<Message>) {
    setMsgs((prev) => ({
      ...prev,
      [conversationId]: (prev[conversationId] ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  }

  /** Garante que canal/tenant da conversa selecionada são válidos antes de qualquer envio. */
  function guardSend(conv: Conversation): { ok: boolean; channel?: Channel } {
    if (!inTenantScope(actor, conv.tenantId)) {
      pushAudit({
        tenantId: conv.tenantId, actorId: actor.id, actorName: user.name,
        targetType: "conversation", targetId: conv.id, action: "access.denied", result: "denied",
        reason: "cross-tenant send blocked",
      });
      toast.error("Envio bloqueado: conversa pertence a outra empresa.");
      return { ok: false };
    }
    const ch = channels.find((c) => c.id === conv.channelId);
    if (!ch || ch.tenantId !== conv.tenantId) {
      toast.error("Canal inválido para esta conversa.");
      return { ok: false };
    }
    return { ok: true, channel: ch };
  }

  async function sendText(text: string) {
    if (!selected || !text.trim()) return;
    const guard = guardSend(selected);
    if (!guard.ok || !guard.channel) return;
    const contact = getContact(selected.contactId);

    const msgId = `m-${Date.now()}`;
    const optimistic: Message = {
      id: msgId,
      conversationId: selected.id,
      direction: "out",
      type: "text",
      text,
      status: "sent",
      createdAt: new Date().toISOString(),
      authorName: user.name,
    };
    appendMsg(selected.id, optimistic);

    if (!selected.assignedTo) {
      // Assumir de verdade no backend (não só no estado local).
      apiPost(`/conversations/${encodeURIComponent(selected.id)}/assume`, {})
        .then((res) => {
          patchConv(selected.id, {
            assignedTo: res.assigned_user_id ?? actor.id,
            assignedUserName: res.assigned_user_name ?? user.name,
            isMine: true,
            status: "open",
          });
          log(selected.id, `${user.name} assumiu a conversa ao responder`);
        })
        .catch(() => {
          /* envio segue mesmo se assume falhar */
        });
    }
    setDraft("");

    // Envio via REST local: POST /api/messages/send (roteia Meta ou Evolution)
    const payload = { conversationId: selected.id, text };
    const channelProvider = guard.channel.provider;
    console.log("send message payload", { ...payload, provider: channelProvider });
    try {
      const result = await apiPost("/messages/send", payload);
      console.log("send message result", { ...result, provider: result.provider ?? channelProvider });
      patchMsg(selected.id, msgId, { status: "delivered" });
      pushAudit({
        tenantId: selected.tenantId, actorId: actor.id, actorName: user.name,
        targetType: "message", targetId: msgId, targetName: contact.name,
        action: "message.sent", result: "success",
        reason: `${String(result.provider ?? channelProvider).toLowerCase()} rest`,
      });
      // Recarrega mensagens e conversas para refletir o estado oficial da API.
      reloadMessages(selected.id, { silent: true });
      reloadConversations({ silent: true });
    } catch (e) {
      patchMsg(selected.id, msgId, { status: "error" });
      toast.error(getApiErrorMessage(e));
      pushAudit({
        tenantId: selected.tenantId, actorId: actor.id, actorName: user.name,
        targetType: "message", targetId: msgId, action: "message.send_error", result: "error",
        reason: e instanceof Error ? e.message : "send error",
      });
    }
  }

  // Allowlist e limites espelham o backend (validação dupla, sem confiar no client).
  const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
  const AUDIO_MIMES = ["audio/mpeg", "audio/mp3", "audio/ogg", "audio/webm", "audio/wav", "audio/mp4"];

  function sendAttachment(type: "image" | "video" | "audio" | "document") {
    if (!selected) return;
    if (sendingMedia) {
      toast.info("Aguarde o envio atual terminar.");
      return;
    }
    if (type === "image" || type === "audio") {
      mediaKindRef.current = type;
      const input = mediaInputRef.current;
      if (input) {
        input.accept = (type === "image" ? IMAGE_MIMES : AUDIO_MIMES).join(",");
        input.value = "";
        input.click();
      }
      return;
    }
    // Vídeo/documento ainda fora do escopo desta fase (sem mock).
    toast.info("Envio de vídeo e documento será habilitado em breve.");
  }

  async function sendMediaFile(file: File, kind: "image" | "audio") {
    if (!selected) return;
    const guard = guardSend(selected);
    if (!guard.ok || !guard.channel) return;

    const mime = (file.type || "").toLowerCase();
    const allowed = kind === "image" ? IMAGE_MIMES : AUDIO_MIMES;
    if (!allowed.includes(mime)) {
      toast.error("Tipo de arquivo não suportado.");
      return;
    }
    const limit = kind === "image" ? 10 * 1024 * 1024 : 16 * 1024 * 1024;
    if (file.size <= 0) {
      toast.error("Arquivo vazio.");
      return;
    }
    if (file.size > limit) {
      toast.error(`Arquivo excede o limite (${kind === "image" ? "10" : "16"} MB).`);
      return;
    }

    setSendingMedia(true);
    const tId = toast.loading(kind === "image" ? "Enviando imagem…" : "Enviando áudio…");
    try {
      const fd = new FormData();
      fd.append("conversationId", selected.id);
      fd.append("file", file);
      await apiPostForm("/messages/send/media/evolution", fd);
      toast.success(kind === "image" ? "Imagem enviada." : "Áudio enviado.", { id: tId });
      reloadMessages(selected.id, { silent: true });
      reloadConversations({ silent: true });
    } catch (e) {
      toast.error(
        e instanceof Error && /too_large/.test(e.message)
          ? "Arquivo grande demais para o canal."
          : "Falha ao enviar mídia. Tente novamente.",
        { id: tId },
      );
    } finally {
      setSendingMedia(false);
    }
  }
  function addInternalNote(text: string) {
    if (!selected || !text.trim()) return;
    appendMsg(selected.id, {
      id: `m-${Date.now()}`,
      conversationId: selected.id,
      direction: "out",
      type: "internal",
      text,
      status: "read",
      createdAt: new Date().toISOString(),
      authorName: user.name,
      isInternalNote: true,
    });
    log(selected.id, `Adicionou nota interna: "${text}"`);
  }
  async function assignTo(userId: string) {
    await transferTo(userId, "assign");
  }

  async function transferTo(userId: string, mode: "transfer" | "assign" = "transfer") {
    if (!selected) return;
    const u = getUser(userId);
    if (u && u.tenantId && u.tenantId !== selected.tenantId) {
      pushAudit({
        tenantId: selected.tenantId, actorId: actor.id, actorName: user.name,
        targetType: "conversation", targetId: selected.id, targetName: getContact(selected.contactId).name,
        action: "conversation.transfer", result: "denied", reason: "cross-tenant transfer",
      });
      toast.error("Não é possível transferir para usuário de outra empresa.");
      return;
    }
    const from = selected.assignedUserName || getUser(selected.assignedTo)?.name || "não atribuída";
    try {
      const res = await apiPost(`/conversations/${encodeURIComponent(selected.id)}/transfer`, {
        userId,
      });
      const isMine = (res.assigned_user_id ?? userId) === actor.id;
      patchConv(selected.id, {
        assignedTo: res.assigned_user_id ?? userId,
        assignedUserName: res.assigned_user_name ?? u?.name,
        isMine,
        status: selected.status === "waiting" ? "open" : selected.status,
      });
      pushAudit({
        tenantId: selected.tenantId, actorId: actor.id, actorName: user.name,
        targetType: "conversation", targetId: selected.id, targetName: getContact(selected.contactId).name,
        action: mode === "assign" ? "conversation.assign" : "conversation.transfer",
        result: "success",
        reason: `${from} → ${res.assigned_user_name ?? u?.name ?? "—"}`,
      });
      log(selected.id, `Atendimento transferido para ${res.assigned_user_name ?? u?.name ?? "—"}`);
      toast.success(mode === "assign" ? "Atendimento atribuído" : "Atendimento transferido");
      await reloadConversations({ silent: true });
      await reloadMessages(selected.id, { silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao transferir atendimento");
    }
  }
  function finish() {
    if (!selected) return;
    patchConv(selected.id, { status: "finished" });
    log(selected.id, "Atendimento finalizado");
  }
  function reopen() {
    if (!selected) return;
    patchConv(selected.id, { status: "open" });
    log(selected.id, "Atendimento reaberto");
  }
  function addTag(tag: string) {
    if (!selected || !tag.trim()) return;
    if (selected.tags.includes(tag)) return;
    patchConv(selected.id, { tags: [...selected.tags, tag] });
    log(selected.id, `Tag adicionada: ${tag}`);
  }
  function removeTag(tag: string) {
    if (!selected) return;
    patchConv(selected.id, { tags: selected.tags.filter((t) => t !== tag) });
    log(selected.id, `Tag removida: ${tag}`);
  }

  return (
    <div className="flex h-full w-full">
      {/* Coluna esquerda — lista de conversas */}
      <section
        className={`${mobileView === "chat" ? "hidden" : "flex"} w-full shrink-0 flex-col border-r border-border bg-card lg:flex lg:w-80`}
      >
        <header className="border-b border-border p-3 pl-12 lg:pl-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar nome, telefone ou mensagem"
              className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 ring-ring"
            />
          </div>

          <div className="mt-3 flex gap-1">
            {statusFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                  statusFilter === f.value
                    ? "bg-whatsapp text-whatsapp-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <FilterSelect
              icon={Filter}
              value={channelFilter}
              onChange={setChannelFilter}
              options={[{ v: "all", l: "Todos canais" }, ...tenantChannels.map((c) => ({ v: c.id, l: channelFilterLabel(c) }))]}
            />
            <FilterSelect
              icon={UserPlus}
              value={assigneeFilter}
              onChange={setAssigneeFilter}
              options={[
                { v: "all", l: "Todos atendentes" },
                { v: "unassigned", l: "Não atribuídas" },
                ...tenantUsers.map((u) => ({ v: u.id, l: u.name })),
              ]}
            />
          </div>
          <div className="mt-2">
            <FilterSelect
              icon={Filter}
              value={typeFilter}
              onChange={(v) => setTypeFilter(v as "all" | "groups" | "individuals")}
              options={[
                { v: "all", l: "Todos os tipos" },
                { v: "groups", l: "Apenas grupos" },
                { v: "individuals", l: "Apenas individuais" },
              ]}
            />
          </div>
          {!canSeeAllConversations(actor) && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {tenant.sharedAttendance
                ? "Atendimento compartilhado: você vê a fila completa do tenant."
                : "Você vê apenas as conversas atribuídas a você + fila sem dono."}
            </p>
          )}
        </header>

        <ul className="flex-1 overflow-y-auto">
          {loadingConvs && (
            <li className="p-6 text-center text-sm text-muted-foreground">Carregando conversas…</li>
          )}
          {!loadingConvs && convsError && (
            <li className="p-6 text-center text-sm">
              <div className="mb-2 text-destructive">Não foi possível carregar conversas.</div>
              <div className="mb-3 text-xs text-muted-foreground">{convsError}</div>
              <button
                onClick={() => reloadConversations()}
                className="rounded-md bg-muted px-3 py-1.5 text-xs hover:bg-accent"
              >
                Tentar novamente
              </button>
            </li>
          )}
          {!loadingConvs && !convsError && filtered.map((c) => (
            <ConversationRow
              key={c.id}
              conv={c}
              msgs={msgs[c.id] ?? []}
              active={c.id === selectedId}
              highlight={highlighted.has(c.id)}
              onClick={() => { setSelectedId(c.id); setMobileView("chat"); }}
            />
          ))}

          {/* Contatos sem conversa no canal alvo — mesmo telefone pode ter conversa em outro canal. */}
          {!loadingConvs && !convsError && search.trim().length >= 2 && contactsWithoutConversation.length > 0 && (
            <>
              <li className="bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {channelFilter !== "all"
                  ? "Iniciar neste canal"
                  : "Iniciar atendimento"}
              </li>
              {contactsWithoutConversation.map((ct) => (
                <ContactResultRow
                  key={`ctr-${ct.id}`}
                  contact={ct}
                  starting={startingContactId === ct.id}
                  onClick={() => startConversationWithContact(ct)}
                />
              ))}
            </>
          )}

          {!loadingConvs && !convsError && filtered.length === 0 && contactsWithoutConversation.length === 0 && (
            <li className="p-6 text-center text-sm text-muted-foreground">
              {search.trim().length >= 2 && searchingContacts ? "Buscando contatos…" : "Nenhuma conversa encontrada."}
            </li>
          )}
        </ul>
      </section>

      {/* Coluna central — chat */}
      <section
        className={`${mobileView === "list" ? "hidden" : "flex"} flex-1 flex-col lg:flex`}
        style={{ backgroundColor: "var(--chat-bg)" }}
      >
        {selected ? (
          <>
            <ChatHeader
              conversation={selected}
              showDetails={showDetails}
              onToggleDetails={() => setShowDetails((v) => !v)}
              onBack={() => setMobileView("list")}
              onAssume={assumeSelf}
            />
            {selected.campaignReplyCampaignId && (
              <div className="border-b border-border bg-amber-50 px-4 py-2 text-xs text-amber-900">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-semibold">
                    Resposta de Campanha
                  </span>
                  <span className="font-medium">{selected.campaignReplyCampaignName}</span>
                  {selected.campaignReplyIntent && (
                    <span className="text-amber-800/80">
                      ·{" "}
                      {selected.campaignReplyIntent === "interested"
                        ? "Interessado"
                        : selected.campaignReplyIntent === "opt_out"
                          ? "Opt-out"
                          : selected.campaignReplyIntent === "not_interested"
                            ? "Sem interesse"
                            : "Resposta"}
                    </span>
                  )}
                </div>
                {selected.campaignReplyText && (
                  <p className="mt-1 truncate text-amber-900/90">
                    Resposta: “{selected.campaignReplyText}”
                  </p>
                )}
              </div>
            )}
            <div ref={messagesScrollRef} className="flex-1 overflow-y-auto px-4 py-4 md:px-6">
              <div className="mx-auto max-w-3xl space-y-2">
                {loadingMsgs && (
                  <div className="py-10 text-center text-xs text-muted-foreground">Carregando mensagens…</div>
                )}
                {!loadingMsgs && msgsError && (
                  <div className="py-10 text-center text-xs">
                    <div className="mb-1 text-destructive">Não foi possível carregar as mensagens.</div>
                    <div className="text-muted-foreground">{msgsError}</div>
                  </div>
                )}
                {!loadingMsgs && !msgsError && messages.map((m) => <Bubble key={m.id} m={m} />)}
                {!loadingMsgs && !msgsError && messages.length === 0 && (
                  <div className="py-10 text-center text-xs text-muted-foreground">Sem mensagens.</div>
                )}
              </div>
            </div>

            {noteOpen && (
              <NoteComposer
                onClose={() => setNoteOpen(false)}
                onSave={(t) => { addInternalNote(t); setNoteOpen(false); }}
              />
            )}

            <input
              ref={mediaInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) sendMediaFile(f, mediaKindRef.current);
                e.target.value = "";
              }}
            />
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSend={() => sendText(draft)}
              onAttach={sendAttachment}
              onInternalNote={() => setNoteOpen(true)}
              disabled={selected.status === "finished"}
              onReopen={reopen}
            />
          </>
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            {loadingConvs ? "Carregando…" : "Selecione uma conversa"}
          </div>
        )}
      </section>

      {/* Coluna direita — só desktop */}
      {showDetails && selected && (
        <div className="hidden md:flex">
          <DetailsPanel
            conversation={selected}
            logs={convLogs}
            attendants={tenantUsers}
            onAssume={assumeSelf}
            onAssign={assignTo}
            onTransfer={transferTo}
            onFinish={finish}
            onReopen={reopen}
            onAddTag={addTag}
            onRemoveTag={removeTag}
            onAddNote={() => setNoteOpen(true)}
          />
        </div>
      )}
    </div>
  );
}

// ───────── Lista lateral ─────────
function ConversationRow({
  conv, msgs, active, highlight, onClick,
}: { conv: Conversation; msgs: Message[]; active: boolean; highlight?: boolean; onClick: () => void }) {
  const ct = getContact(conv.contactId);
  const ch = getChannel(conv.channelId);
  const last = msgs[msgs.length - 1];
  const preview =
    last?.type === "text" || last?.type === "internal" ? last?.text :
    last?.type === "image" ? "📷 Imagem" :
    last?.type === "audio" ? "🎤 Áudio" :
    last?.type === "video" ? "🎬 Vídeo" :
    last?.type === "document" ? `📄 ${last.fileName ?? "Documento"}` :
    last?.type === "contact" ? "👤 Contato compartilhado" :
    last?.type === "contacts" ? "👥 Contatos compartilhados" :
    last?.type === "system" ? (last.text || "Evento do sistema") :
    "";

  return (
    <li>
      <button
        onClick={onClick}
        className={`flex w-full items-start gap-3 border-b border-border px-3 py-3 text-left transition-colors ${
          active ? "bg-accent/60" : highlight ? "bg-whatsapp/10 animate-pulse" : "hover:bg-muted/60"
        }`}
      >
        <div
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: ct.avatarColor }}
        >
          {(ct.name || ct.phone || "?").split(" ").map((p) => p[0]).slice(0, 2).join("")}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium">{ct.name || ct.phone}</span>

            <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(conv.lastMessageAt)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-muted-foreground">{preview}</span>
            {conv.unreadCount > 0 && (
              <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-whatsapp px-1.5 text-[11px] font-semibold text-whatsapp-foreground">
                {conv.unreadCount}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{ch.name}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              ch.provider === "META" ? "bg-primary/10 text-primary" : "bg-whatsapp/10 text-whatsapp"
            }`}>{ch.provider}</span>
            {groupContactIds.has(conv.contactId) && (
              <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600">Grupo</span>
            )}
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                conv.isMine
                  ? "bg-whatsapp/15 text-whatsapp"
                  : conv.assignedTo
                    ? "bg-amber-500/15 text-amber-700"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {conv.isMine
                ? "Você"
                : conv.assignedTo
                  ? (conv.assignedUserName || getUser(conv.assignedTo)?.name || "Atendente")
                  : "Sem responsável"}
            </span>
            {conv.campaignReplyCampaignId && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                Campanha
              </span>
            )}
            <StatusChip status={conv.status} />
          </div>
        </div>
      </button>
    </li>
  );
}

function ContactResultRow({
  contact, starting, onClick,
}: { contact: Contact; starting?: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={onClick}
        disabled={starting}
        className="flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
      >
        <div
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: contact.avatarColor }}
        >
          {(contact.name || contact.phone || "?").split(" ").map((p) => p[0]).slice(0, 2).join("")}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{contact.name || contact.phone}</div>
          {contact.phone && <div className="truncate text-xs text-muted-foreground">{phoneLabel(contact.phone)}</div>}
          <div className="mt-1">
            <span className="inline-flex items-center gap-1 rounded bg-whatsapp/10 px-1.5 py-0.5 text-[10px] font-medium text-whatsapp">
              <UserPlus className="h-3 w-3" />
              {starting ? "Abrindo…" : "Novo atendimento"}
            </span>
          </div>
        </div>
      </button>
    </li>
  );
}

function StatusChip({ status }: { status: ConversationStatus }) {
  if (status === "waiting") return <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">Aguardando</span>;
  if (status === "finished") return <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Finalizada</span>;
  return <span className="rounded bg-whatsapp/10 px-1.5 py-0.5 text-[10px] font-medium text-whatsapp">Aberta</span>;
}

function FilterSelect({
  icon: Icon, value, onChange, options,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <div className="relative">
      <Icon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-md border border-input bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:ring-2 ring-ring"
      >
        {options.map((o) => (<option key={o.v} value={o.v}>{o.l}</option>))}
      </select>
    </div>
  );
}

// ───────── Header do chat ─────────
function ChatHeader({
  conversation, showDetails, onToggleDetails, onBack, onAssume,
}: {
  conversation: Conversation;
  showDetails: boolean;
  onToggleDetails: () => void;
  onBack?: () => void;
  onAssume?: () => void;
}) {
  const ct = getContact(conversation.contactId);
  const ch = getChannel(conversation.channelId);
  const isGroup = groupContactIds.has(conversation.contactId);
  const showAssume = !conversation.assignedTo && !!onAssume;
  return (
    <header className="flex items-center justify-between border-b border-border bg-card px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted lg:hidden"
            title="Voltar"
            aria-label="Voltar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
        )}
        <div
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: ct.avatarColor }}
        >
          {ct.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{ct.name || ct.phone}</span>
            {isGroup && (
              <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600">Grupo</span>
            )}
            {conversation.campaignReplyCampaignId && (
              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                Campanha
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {!isGroup && ct.phone ? `${phoneLabel(ct.phone)} · ` : ""}{ch.name} · {responsibleLabel(conversation)}
          </div>
        </div>

      </div>
      <div className="flex items-center gap-1 text-muted-foreground sm:gap-2">
        {showAssume && (
          <button
            type="button"
            onClick={onAssume}
            className="inline-flex items-center gap-1 rounded-md bg-whatsapp px-2.5 py-1.5 text-xs font-medium text-whatsapp-foreground hover:opacity-90"
          >
            <CheckCircle className="h-3.5 w-3.5" />
            Assumir atendimento
          </button>
        )}
        <ChannelModeBadge channel={ch} />
        <button className="hidden rounded-md p-2 hover:bg-muted sm:inline-flex" title="Ligar"><Phone className="h-4 w-4" /></button>
        <button className="hidden rounded-md p-2 hover:bg-muted sm:inline-flex" title="Vídeo"><Video className="h-4 w-4" /></button>
        <button onClick={onToggleDetails} className="hidden rounded-md p-2 hover:bg-muted lg:inline-flex" title={showDetails ? "Ocultar painel" : "Exibir painel"}>
          {showDetails ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </button>
        <button className="rounded-md p-2 hover:bg-muted" title="Mais"><MoreVertical className="h-4 w-4" /></button>
      </div>
    </header>
  );
}

function ChannelModeBadge({ channel }: { channel: Channel }) {
  const connected = isChannelOperational(channel);
  const phoneHint = channel.phone ? ` · ${channel.phone}` : "";
  const metaHint = channel.provider === "META" ? " · Cloud API" : "";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        connected ? "bg-whatsapp/10 text-whatsapp" : "bg-destructive/10 text-destructive"
      }`}
      title={`${channel.provider}${phoneHint}${metaHint} ${connected ? "operacional" : "indisponível"}`}
    >
      {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
      {channel.provider}
    </span>
  );
}

// ───────── Balão ─────────
function Bubble({ m }: { m: Message }) {
  try {
    return <BubbleInner m={m} />;
  } catch (err) {
    console.error("[BUBBLE_RENDER_ERROR]", err);
    return (
      <div className="mx-auto max-w-xl rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-center text-xs text-destructive">
        Mensagem não pôde ser exibida.
      </div>
    );
  }
}

function BubbleInner({ m }: { m: Message }) {
  if (m.type === "internal" || m.isInternalNote) {
    return (
      <div className="mx-auto max-w-xl rounded-md border border-internal/30 bg-internal/10 px-3 py-2 text-center text-xs text-internal">
        <StickyNote className="mr-1 inline h-3.5 w-3.5" /> Nota interna · {m.authorName}: {m.text}
      </div>
    );
  }
  if (m.type === "system") {
    return (
      <div className="mx-auto max-w-xl rounded-md border border-border bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
        {m.text || "Evento do sistema"}
      </div>
    );
  }
  if (m.type === "reaction") {
    const reactedOut = m.direction === "out";
    const who = reactedOut ? (m.authorName || "Atendente") : "Cliente";
    const reactionLabel = m.reactionEmoji
      ? `${who} reagiu com ${m.reactionEmoji}`
      : (m.text || `${who} reagiu`);
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground">
          {reactionLabel}
        </span>
      </div>
    );
  }
  if (m.type === "contact" || m.type === "contacts") {
    const out = m.direction === "out";
    const contacts =
      m.sharedContacts && m.sharedContacts.length > 0
        ? m.sharedContacts
        : [{ name: undefined, phone: undefined }];
    return (
      <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
        <div
          className={`max-w-[78%] rounded-lg px-3 py-2 text-sm shadow-sm ${out ? "rounded-tr-none" : "rounded-tl-none"}`}
          style={{ backgroundColor: out ? "var(--bubble-out)" : "var(--bubble-in)" }}
        >
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
            <ContactRound className="h-3.5 w-3.5" />
            Contato compartilhado
          </div>
          <div className="space-y-2">
            {contacts.map((c, i) => (
              <div
                key={`sc-${m.id}-${i}`}
                className="rounded-md border border-black/10 bg-black/5 px-2.5 py-2"
              >
                <div className="text-sm font-medium">
                  Nome: {c.name?.trim() || "—"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Telefone: {phoneLabel(c.phone) || "—"}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
            {out && m.authorName && <span className="font-medium">{m.authorName}</span>}
            {out && m.authorName && <span aria-hidden>·</span>}
            <span>{formatTime(m.createdAt)}</span>
            {out && <StatusIcon status={m.status} />}
          </div>
        </div>
      </div>
    );
  }
  const isMedia = m.type === "image" || m.type === "audio" || m.type === "video" || m.type === "document";
  // Estratégia definitiva: media_url já vem salvo pelo webhook (storage público).
  // Não tentamos mais resolver via proxy/base64 sob demanda.
  const resolvedUrl: string | undefined = m.mediaUrl;
  const loadingMedia = false;
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (!isMedia) return;
    console.log("[MESSAGE_MEDIA_RENDER]", {
      id: m.id,
      media_type: m.type,
      mime_type: m.mimeType,
      has_media_url: !!resolvedUrl,
      media_url_start: resolvedUrl?.slice(0, 60),
    });
  }, [m.id, isMedia, resolvedUrl, m.type, m.mimeType]);

  const out = m.direction === "out";
  const isImagePlaceholder = m.type === "image" && (m.text === "[imagem]" || !m.text);
  const captionText = isImagePlaceholder ? undefined : m.text;

  const viewUrl = resolvedUrl;
  const downloadUrl = resolvedUrl;

  const openInNewTab = (url?: string, mode: "open" | "download" = "open") => {
    if (!url) return;
    if (typeof window === "undefined") return;
    console.log(mode === "download" ? "[MEDIA_CLICK_DOWNLOAD]" : "[MEDIA_CLICK_OPEN]", {
      messageId: m.id,
      type: m.type,
    });
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("[MEDIA_CLICK_ERROR]", err);
    }
  };

  const onPreviewClick = () => {
    if (resolvedUrl) setPreviewOpen(true);
    else openInNewTab(viewUrl, "open");
  };

  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-lg px-3 py-2 text-sm shadow-sm ${out ? "rounded-tr-none" : "rounded-tl-none"}`}
        style={{ backgroundColor: out ? "var(--bubble-out)" : "var(--bubble-in)" }}
      >
        {isMedia && loadingMedia && !resolvedUrl && (
          <div className="mb-1 rounded-md bg-black/5 px-3 py-2 text-[11px] text-muted-foreground">Carregando mídia…</div>
        )}
        {m.type === "image" && (
          resolvedUrl ? (
            <>
              <img
                src={resolvedUrl}
                alt={m.fileName || captionText || "imagem"}
                onClick={() => setPreviewOpen(true)}
                className="mb-1 w-full max-w-full cursor-zoom-in rounded-md object-cover sm:max-w-[280px]"
              />
              {previewOpen && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
                  onClick={() => setPreviewOpen(false)}
                >
                  <img
                    src={resolvedUrl}
                    alt={m.fileName || captionText || "imagem"}
                    className="max-h-[90vh] max-w-[90vw] rounded-md object-contain"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <button
                    onClick={() => setPreviewOpen(false)}
                    className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
                    aria-label="Fechar"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              )}
              {downloadUrl && (
                <div className="mt-1">
                  <button
                    type="button"
                    onClick={() => openInNewTab(downloadUrl, "download")}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:underline"
                  >
                    <Download className="h-3 w-3" /> Baixar
                  </button>
                </div>
              )}
            </>
          ) : (!loadingMedia && (
            <div className="mb-1 flex w-full max-w-full flex-col gap-2 rounded-md border border-black/10 bg-black/5 p-2 sm:max-w-[280px]">
              {m.thumbnailUrl ? (
                <img
                  src={m.thumbnailUrl}
                  alt={captionText || "miniatura"}
                  onClick={onPreviewClick}
                  className="cursor-pointer rounded-md object-cover"
                />
              ) : (
                <div className="flex items-center gap-2 px-1 py-2 text-[12px] text-muted-foreground">
                  <ImageIcon className="h-5 w-5" />
                  <span>Imagem</span>
                </div>
              )}
              <div className="flex gap-2">
                {viewUrl ? (
                  <button
                    type="button"
                    onClick={() => openInNewTab(viewUrl, "open")}
                    className="flex-1 rounded-md bg-whatsapp px-2 py-1 text-center text-[11px] font-medium text-white hover:bg-whatsapp/90"
                  >
                    Visualizar
                  </button>
                ) : (
                  <TechnicalMediaError error={m.mediaError} />
                )}
                {downloadUrl && (
                  <button
                    type="button"
                    onClick={() => openInNewTab(downloadUrl, "download")}
                    className="rounded-md border border-black/10 px-2 py-1 text-[11px] hover:bg-black/5"
                  >
                    <Download className="inline h-3 w-3" /> Baixar
                  </button>
                )}
              </div>
            </div>
          ))
        )}
        {m.type === "video" && (
          resolvedUrl ? (
            <video src={resolvedUrl} controls className="mb-1 max-h-72 rounded-md" />
          ) : (!loadingMedia && (
            <MediaActionCard kind="video" mime={m.mimeType} caption={m.fileName} viewUrl={viewUrl} downloadUrl={downloadUrl} mediaError={m.mediaError} />
          ))
        )}
        {m.type === "audio" && (
          resolvedUrl ? (
            <audio src={resolvedUrl} controls className="mb-1 w-64 max-w-full" />
          ) : (!loadingMedia && (
            <MediaActionCard kind="audio" mime={m.mimeType} viewUrl={viewUrl} downloadUrl={downloadUrl} mediaError={m.mediaError} />
          ))
        )}
        {m.type === "document" && (
          <div className="mb-1 flex items-center gap-2 rounded-md bg-black/5 px-2 py-2">
            <FileText className="h-6 w-6 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{m.fileName || "Documento"}</div>
              <div className="text-[11px] text-muted-foreground">{formatBytes(m.fileSize)} · {m.mimeType}</div>
            </div>
            {resolvedUrl ? (
              <button
                type="button"
                onClick={() => openInNewTab(resolvedUrl, "download")}
                className="rounded-md p-1.5 hover:bg-black/10"
              >
                <Download className="h-4 w-4" />
              </button>
            ) : (
              <TechnicalMediaError error={m.mediaError} compact />
            )}
          </div>
        )}
        {m.type === "image" ? (
          captionText && <div className="whitespace-pre-wrap">{captionText}</div>
        ) : (
          m.text && <div className="whitespace-pre-wrap">{m.text}</div>
        )}
        {m.templateButtons && m.templateButtons.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-black/10 pt-2">
            {m.templateButtons.map((label) => (
              <div
                key={`${m.id}-btn-${label}`}
                className="rounded-md border border-black/10 bg-background/80 px-2.5 py-1.5 text-center text-xs font-medium text-primary"
              >
                {label}
              </div>
            ))}
          </div>
        )}
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
          {out && m.authorName && <span className="font-medium">{m.authorName}</span>}
          {out && m.authorName && <span aria-hidden>·</span>}
          <span>{formatTime(m.createdAt)}</span>
          {out && <StatusIcon status={m.status} />}
        </div>
      </div>
    </div>
  );
}

function TechnicalMediaError({ error, compact = false }: { error?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={compact ? "min-w-0" : "flex-1"}>
      <div className="rounded-md bg-destructive/10 px-2 py-1 text-center text-[11px] text-destructive">
        Mídia não disponível para visualização
      </div>
      {error && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1 text-[11px] font-medium text-destructive hover:underline"
          >
            Ver erro técnico
          </button>
          {open && (
            <pre className="mt-1 max-h-48 max-w-[280px] overflow-auto whitespace-pre-wrap rounded-md border border-destructive/20 bg-background p-2 text-[10px] text-foreground">
              {error}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function MediaActionCard({
  kind, mime, caption, viewUrl, downloadUrl, mediaError,
}: {
  kind: "image" | "audio" | "video" | "document";
  mime?: string; caption?: string; viewUrl?: string; downloadUrl?: string; mediaError?: string;
}) {
  const meta = {
    image:    { Icon: ImageIcon, label: "Imagem" },
    audio:    { Icon: FileAudio, label: "Áudio" },
    video:    { Icon: FileVideo, label: "Vídeo" },
    document: { Icon: FileText,  label: "Documento" },
  }[kind];
  const Icon = meta.Icon;
  return (
    <div className="mb-1 flex w-full max-w-full flex-col gap-2 rounded-md border border-black/10 bg-black/5 p-2 sm:max-w-[280px]">
      <div className="flex items-center gap-2 px-1 py-1">
        <Icon className="h-5 w-5 text-whatsapp" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{meta.label}</div>
          <div className="truncate text-[11px] text-muted-foreground">{mime || "—"}</div>
          {caption && <div className="truncate text-[11px] text-muted-foreground">{caption}</div>}
        </div>
      </div>
      <div className="flex gap-2">
        {viewUrl ? (
          <button
            type="button"
            onClick={() => {
              if (typeof window === "undefined") return;
              console.log("[MEDIA_CLICK_OPEN]", { kind });
              try { window.open(viewUrl, "_blank", "noopener,noreferrer"); }
              catch (err) { console.error("[MEDIA_CLICK_ERROR]", err); }
            }}
            className="flex-1 rounded-md bg-whatsapp px-2 py-1 text-center text-[11px] font-medium text-white hover:bg-whatsapp/90">
            {kind === "audio" ? "Ouvir áudio" : "Visualizar"}
          </button>
        ) : (
          <TechnicalMediaError error={mediaError} />
        )}
        {downloadUrl && (
          <button
            type="button"
            onClick={() => {
              if (typeof window === "undefined") return;
              console.log("[MEDIA_CLICK_DOWNLOAD]", { kind });
              try { window.open(downloadUrl, "_blank", "noopener,noreferrer"); }
              catch (err) { console.error("[MEDIA_CLICK_ERROR]", err); }
            }}
            className="rounded-md border border-black/10 px-2 py-1 text-[11px] hover:bg-black/5">
            <Download className="inline h-3 w-3" /> {kind === "audio" ? "Baixar áudio" : "Baixar"}
          </button>
        )}
      </div>
    </div>
  );
}

function MediaPlaceholder({
  kind, mime, caption,
}: { kind: "image" | "audio" | "video" | "document"; mime?: string; caption?: string }) {
  const meta = {
    image:    { Icon: ImageIcon, label: "Imagem recebida" },
    audio:    { Icon: FileAudio, label: "Áudio recebido" },
    video:    { Icon: FileVideo, label: "Vídeo recebido" },
    document: { Icon: FileText,  label: "Documento recebido" },
  }[kind];
  const Icon = meta.Icon;
  return (
    <div className="mb-1 flex items-center gap-3 rounded-md border border-black/10 bg-black/5 px-3 py-2">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-whatsapp/15 text-whatsapp">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{meta.label}</div>
        <div className="truncate text-[11px] text-muted-foreground">{mime || "tipo desconhecido"}</div>
        {caption && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{caption}</div>}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: Message["status"] }) {
  if (status === "error") return <AlertCircle className="h-3 w-3 text-destructive" />;
  if (status === "read") return <CheckCheck className="h-3 w-3 text-primary" />;
  if (status === "delivered") return <CheckCheck className="h-3 w-3" />;
  return <Check className="h-3 w-3" />;
}

// ───────── Composer ─────────
function ChatComposer({
  value, onChange, onSend, onAttach, onInternalNote, disabled, onReopen,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onAttach: (type: "image" | "video" | "audio" | "document") => void;
  onInternalNote: () => void;
  disabled?: boolean;
  onReopen: () => void;
}) {
  const [attachOpen, setAttachOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAttachOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  if (disabled) {
    return (
      <div className="border-t border-border bg-card px-4 py-3">
        <div className="rounded-md bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
          Atendimento finalizado ·{" "}
          <button onClick={onReopen} className="font-medium text-primary hover:underline">Reabrir</button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <button onClick={onInternalNote} className="rounded-md p-2 text-internal hover:bg-internal/10" title="Nota interna">
          <StickyNote className="h-5 w-5" />
        </button>
        <button className="rounded-md p-2 text-muted-foreground hover:bg-muted" title="Emojis"><Smile className="h-5 w-5" /></button>

        <div ref={ref} className="relative">
          <button
            onClick={() => setAttachOpen((v) => !v)}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted"
            title="Anexar"
          >
            <Paperclip className="h-5 w-5" />
          </button>
          {attachOpen && (
            <div className="absolute bottom-12 left-0 z-10 w-44 rounded-md border border-border bg-popover p-1 text-sm shadow-md">
              {[
                { t: "image" as const, l: "Imagem", I: ImageIcon },
                { t: "video" as const, l: "Vídeo", I: FileVideo },
                { t: "audio" as const, l: "Áudio", I: FileAudio },
                { t: "document" as const, l: "Documento", I: FileText },
              ].map(({ t, l, I }) => (
                <button
                  key={t}
                  onClick={() => { onAttach(t); setAttachOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                >
                  <I className="h-4 w-4 text-muted-foreground" /> {l}
                </button>
              ))}
            </div>
          )}
        </div>

        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          placeholder="Digite uma mensagem"
          className="flex-1 rounded-full border border-input bg-background px-4 py-2 text-sm outline-none focus:ring-2 ring-ring"
        />
        {value.trim() ? (
          <button
            onClick={onSend}
            className="grid h-10 w-10 place-items-center rounded-full bg-whatsapp text-whatsapp-foreground hover:opacity-90"
            title="Enviar"
          >
            <Send className="h-4 w-4" />
          </button>
        ) : (
          <button className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground hover:bg-accent" title="Gravar áudio">
            <Mic className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function NoteComposer({ onClose, onSave }: { onClose: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="border-t border-internal/30 bg-internal/5 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-internal">
        <StickyNote className="h-4 w-4" /> Nota interna (não enviada ao cliente)
        <button onClick={onClose} className="ml-auto rounded p-1 hover:bg-internal/10"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Escreva uma observação visível só para a equipe…"
          className="flex-1 resize-none rounded-md border border-internal/30 bg-background px-3 py-2 text-sm outline-none focus:ring-2 ring-internal"
        />
        <button
          onClick={() => onSave(text)}
          disabled={!text.trim()}
          className="rounded-md bg-internal px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Salvar nota
        </button>
      </div>
    </div>
  );
}

// ───────── Painel direito ─────────
function DetailsPanel({
  conversation, logs, attendants,
  onAssume, onAssign, onTransfer, onFinish, onReopen, onAddTag, onRemoveTag, onAddNote,
}: {
  conversation: Conversation;
  logs: LogEntry[];
  attendants: AttUser[];
  onAssume: () => void;
  onAssign: (userId: string) => void;
  onTransfer: (userId: string) => void;
  onFinish: () => void;
  onReopen: () => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onAddNote: () => void;
}) {
  const ct = getContact(conversation.contactId);
  const ch = getChannel(conversation.channelId);
  const assignee = getUser(conversation.assignedTo);
  const [newTag, setNewTag] = useState("");
  const [picker, setPicker] = useState<"assign" | "transfer" | null>(null);

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-card lg:flex">
      <div className="flex flex-col items-center border-b border-border p-6">
        <div
          className="grid h-20 w-20 place-items-center rounded-full text-2xl font-semibold text-white"
          style={{ backgroundColor: ct.avatarColor }}
        >
          {ct.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
        </div>
        <div className="mt-3 text-base font-medium">{ct.name}</div>
        <div className="text-xs text-muted-foreground">{phoneLabel(ct.phone) || "—"}</div>
        {ct.email && <div className="text-xs text-muted-foreground">{ct.email}</div>}
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section title="Ações">
          {picker ? (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">
                {picker === "assign" ? "Atribuir para:" : "Transferir para:"}
              </div>
              <div className="grid grid-cols-1 gap-1">
                {attendants.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => {
                      picker === "assign" ? onAssign(u.id) : onTransfer(u.id);
                      setPicker(null);
                    }}
                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    <div
                      className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold text-white"
                      style={{ backgroundColor: u.avatarColor }}
                    >
                      {u.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
                    </div>
                    <span className="flex-1 truncate">{u.name}</span>
                    <span className="text-[10px] text-muted-foreground">{u.role}</span>
                  </button>
                ))}
              </div>
              <button onClick={() => setPicker(null)} className="w-full rounded-md px-2 py-1 text-xs hover:bg-muted">Cancelar</button>
            </div>
          ) : (
            <>
              <ActionButton icon={CheckCircle} label="Assumir atendimento" tone="primary" onClick={onAssume} />
              <ActionButton icon={UserPlus} label="Atribuir" onClick={() => setPicker("assign")} />
              <ActionButton icon={ArrowRightLeft} label="Transferir" onClick={() => setPicker("transfer")} />
              <ActionButton icon={StickyNote} label="Nota interna" onClick={onAddNote} />
              {conversation.status === "finished"
                ? <ActionButton icon={RotateCcw} label="Reabrir conversa" tone="primary" onClick={onReopen} />
                : <ActionButton icon={CheckCircle} label="Finalizar conversa" onClick={onFinish} />}
            </>
          )}
        </Section>

        <Section title="Canal">
          <Row label="Nome" value={ch.name} />
          <Row label="Número" value={ch.phone || "—"} />
          <Row label="Provedor" value={ch.provider} />
        </Section>

        <Section title="Atendimento">
          <Row label="Status" value={conversation.status} />
          <Row
            label="Responsável"
            value={
              conversation.isMine
                ? "Você"
                : conversation.assignedUserName || assignee?.name || "Sem responsável"
            }
          />
        </Section>

        <Section title="Tags da conversa">
          <div className="flex flex-wrap gap-1.5">
            {conversation.tags.length === 0 && <span className="text-xs text-muted-foreground">Nenhuma tag.</span>}
            {conversation.tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">
                {t}
                <button onClick={() => onRemoveTag(t)} className="rounded-full p-0.5 hover:bg-black/10" title="Remover">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { onAddTag(newTag); setNewTag(""); } }}
              placeholder="Nova tag"
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus:ring-2 ring-ring"
            />
            <button
              onClick={() => { onAddTag(newTag); setNewTag(""); }}
              className="rounded-md bg-muted px-2 py-1 text-xs hover:bg-accent"
            >
              <Tag className="h-3.5 w-3.5" />
            </button>
          </div>
        </Section>

        <Section title="Histórico de atendimento">
          {logs.length === 0 ? (
            <p className="text-xs text-muted-foreground">Ainda sem registros.</p>
          ) : (
            <ul className="space-y-2">
              {logs.map((l) => (
                <li key={l.id} className="flex gap-2 rounded-md bg-muted/40 p-2 text-xs">
                  <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{l.text}</div>
                    <div className="text-[10px] text-muted-foreground">{l.author} · {formatTime(l.at)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function ActionButton({
  icon: Icon, label, tone, onClick,
}: { icon: React.ComponentType<{ className?: string }>; label: string; tone?: "primary"; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-muted ${
        tone === "primary" ? "bg-whatsapp text-whatsapp-foreground border-transparent hover:opacity-90" : ""
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
