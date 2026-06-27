// Mocks navegáveis do NexaBoot (Fase 1). Substituir por dados Supabase nas próximas fases.

export type Provider = "META" | "EVOLUTION" | "INTERNAL";
export type ChannelStatus = "connected" | "disconnected" | "pending" | "error";
export type MessageType = "text" | "image" | "audio" | "document" | "video" | "internal";
export type MessageDirection = "in" | "out";
export type MessageStatus = "sent" | "delivered" | "read" | "error";
export type ConversationStatus = "open" | "waiting" | "finished";
export type Role =
  | "ADMIN_GERAL"
  | "TI"
  | "ADMIN_EMPRESA"
  | "GERENTE"
  | "SUPERVISOR"
  | "ATENDENTE_GERAL"
  | "ATENDENTE";

export interface Tenant {
  id: string;
  name: string;
  cnpj: string;
  plan: "Free" | "Pro" | "Business";
  status: "ativo" | "suspenso";
  /** Se true, todos os atendentes do tenant podem ver as conversas em aberto/aguardando/fila. */
  sharedAttendance: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  tenantId: string;
  avatarColor: string;
}

export interface EvolutionConfig {
  apiUrl: string;
  apiKey: string;
  instanceName: string;
  webhookUrl: string;
  events: {
    text: boolean;
    image: boolean;
    audio: boolean;
    document: boolean;
    video: boolean;
  };
}

export interface MetaConfig {
  apiUrl: string;
  apiToken: string;
  phoneNumberId: string;
  wabaId: string;
  webhookUrl: string;
  verifyToken: string;
}

export interface Channel {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  provider: Provider;
  status: ChannelStatus;
  /** Configuração específica do provedor (jsonb em produção). */
  evolution?: EvolutionConfig;
  meta?: MetaConfig;
}

export type ContactStatus = "ativo" | "inativo" | "lead";

export interface Contact {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  email?: string;
  reference?: string;
  status?: ContactStatus;
  tags: string[];
  notes?: string;
  avatarColor: string;
}

export interface Message {
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
  createdAt: string; // ISO
  authorName?: string;
  isInternalNote?: boolean;
  /** Miniatura base64 (jpegThumbnail) quando disponível no payload da Evolution. */
  thumbnailUrl?: string;
  /** Parâmetros para baixar a mídia via /api/messages/:id/media. */
  mediaParams?: {
    serverUrl?: string;
    apikey?: string;
    instance?: string;
    keyId?: string;
    remoteJid?: string;
    fromMe?: boolean;
    mimetype?: string;
  };
}

export interface Conversation {
  id: string;
  tenantId: string;
  channelId: string;
  contactId: string;
  status: ConversationStatus;
  unreadCount: number;
  assignedTo?: string; // userId
  lastMessageAt: string;
  tags: string[];
}

const colors = [
  "#00a884", "#06cf9c", "#3b82f6", "#8b5cf6",
  "#ec4899", "#f59e0b", "#ef4444", "#14b8a6",
];
const pick = (i: number) => colors[i % colors.length];

export const currentTenant: Tenant = {
  id: "t-1",
  name: "Acme Atendimento",
  cnpj: "12.345.678/0001-90",
  plan: "Pro",
  status: "ativo",
  sharedAttendance: true,
};

export const tenants: Tenant[] = [
  currentTenant,
  { id: "t-2", name: "Clínica Bem-Estar", cnpj: "98.765.432/0001-10", plan: "Business", status: "ativo", sharedAttendance: false },
  { id: "t-3", name: "Loja Verde", cnpj: "11.222.333/0001-44", plan: "Free", status: "suspenso", sharedAttendance: false },
];

export const currentUser: User = {
  id: "u-1",
  name: "Ana Souza",
  email: "ana@acme.com",
  role: "ADMIN_EMPRESA",
  tenantId: "t-1",
  avatarColor: pick(0),
};

export const users: User[] = [
  currentUser,
  { id: "u-2", name: "Bruno Lima", email: "bruno@acme.com", role: "ATENDENTE", tenantId: "t-1", avatarColor: pick(2) },
  { id: "u-3", name: "Carla Dias", email: "carla@acme.com", role: "SUPERVISOR", tenantId: "t-1", avatarColor: pick(4) },
  { id: "u-4", name: "Diego Reis", email: "diego@acme.com", role: "ATENDENTE", tenantId: "t-1", avatarColor: pick(5) },
  { id: "u-9", name: "Renata Pool", email: "renata@acme.com", role: "ATENDENTE_GERAL", tenantId: "t-1", avatarColor: pick(0) },
  { id: "u-10", name: "Mateus Gomes", email: "mateus@acme.com", role: "GERENTE", tenantId: "t-1", avatarColor: pick(1) },
  // Usuários de OUTRAS empresas — usados para validar isolamento multitenant.
  { id: "u-5", name: "Eduarda Melo", email: "eduarda@bem-estar.com", role: "ADMIN_EMPRESA", tenantId: "t-2", avatarColor: pick(6) },
  { id: "u-6", name: "Felipe Castro", email: "felipe@bem-estar.com", role: "ATENDENTE", tenantId: "t-2", avatarColor: pick(7) },
  { id: "u-7", name: "Gustavo Lopes", email: "gustavo@lojaverde.com", role: "ADMIN_EMPRESA", tenantId: "t-3", avatarColor: pick(1) },
  // Equipe técnica/plataforma
  { id: "u-11", name: "Iago Tech", email: "iago@nexaboot.com", role: "TI", tenantId: "t-1", avatarColor: pick(7) },
  { id: "u-0", name: "Helena Admin", email: "helena@nexaboot.com", role: "ADMIN_GERAL", tenantId: "t-1", avatarColor: pick(3) },
];

export const channels: Channel[] = [
  { id: "c-1", tenantId: "t-1", name: "Vendas Oficial", phone: "+55 11 90000-0001", provider: "META", status: "connected" },
  { id: "c-2", tenantId: "t-1", name: "Suporte", phone: "+55 11 90000-0002", provider: "EVOLUTION", status: "connected" },
  { id: "c-3", tenantId: "t-1", name: "Financeiro", phone: "+55 11 90000-0003", provider: "EVOLUTION", status: "pending" },
  { id: "c-4", tenantId: "t-1", name: "Marketing", phone: "+55 11 90000-0004", provider: "META", status: "error" },
  { id: "c-5", tenantId: "t-2", name: "Clínica WhatsApp", phone: "+55 11 90000-2001", provider: "META", status: "connected" },
  { id: "c-6", tenantId: "t-3", name: "Loja Verde", phone: "+55 11 90000-3001", provider: "EVOLUTION", status: "disconnected" },
];

export const contacts: Contact[] = [
  { id: "ct-1", tenantId: "t-1", name: "João Pereira", phone: "5511988881111", email: "joao@email.com", reference: "Site", status: "ativo", tags: ["VIP"], avatarColor: pick(1) },
  { id: "ct-2", tenantId: "t-1", name: "Maria Santos", phone: "5511988882222", reference: "Indicação", status: "lead", tags: ["Lead"], avatarColor: pick(3) },
  { id: "ct-3", tenantId: "t-1", name: "Pedro Oliveira", phone: "5511988883333", status: "ativo", tags: [], avatarColor: pick(5) },
  { id: "ct-4", tenantId: "t-1", name: "Juliana Costa", phone: "5511988884444", status: "ativo", tags: ["Recorrente"], avatarColor: pick(6) },
  { id: "ct-5", tenantId: "t-1", name: "Lucas Almeida", phone: "5511988885555", status: "inativo", tags: [], avatarColor: pick(7) },
  { id: "ct-6", tenantId: "t-1", name: "Fernanda Rocha", phone: "5511988886666", reference: "Campanha", status: "ativo", tags: ["VIP", "Recorrente"], avatarColor: pick(2) },
  // Outras empresas — para validar isolamento na importação.
  { id: "ct-7", tenantId: "t-2", name: "Carlos Bem", phone: "5511977770001", status: "ativo", tags: [], avatarColor: pick(4) },
  { id: "ct-8", tenantId: "t-3", name: "Loja Verde Cliente", phone: "5511966660001", status: "ativo", tags: [], avatarColor: pick(0) },
];

// Base estável para SSR == cliente (evita hydration mismatch).
const BASE_NOW = Date.parse("2026-05-19T22:00:00.000Z");
const min = (m: number) => new Date(BASE_NOW - m * 60_000).toISOString();
const hour = (h: number) => new Date(BASE_NOW - h * 3600_000).toISOString();

export const conversations: Conversation[] = [
  { id: "cv-1", tenantId: "t-1", channelId: "c-1", contactId: "ct-1", status: "open", unreadCount: 2, assignedTo: "u-1", lastMessageAt: min(2), tags: ["VIP"] },
  { id: "cv-2", tenantId: "t-1", channelId: "c-2", contactId: "ct-2", status: "waiting", unreadCount: 5, lastMessageAt: min(8), tags: ["Lead"] },
  { id: "cv-3", tenantId: "t-1", channelId: "c-1", contactId: "ct-3", status: "open", unreadCount: 0, assignedTo: "u-2", lastMessageAt: min(34), tags: [] },
  { id: "cv-4", tenantId: "t-1", channelId: "c-2", contactId: "ct-4", status: "open", unreadCount: 1, assignedTo: "u-1", lastMessageAt: hour(2), tags: ["Recorrente"] },
  { id: "cv-5", tenantId: "t-1", channelId: "c-1", contactId: "ct-5", status: "finished", unreadCount: 0, assignedTo: "u-4", lastMessageAt: hour(20), tags: [] },
  { id: "cv-6", tenantId: "t-1", channelId: "c-2", contactId: "ct-6", status: "open", unreadCount: 0, assignedTo: "u-3", lastMessageAt: hour(28), tags: ["VIP"] },
  // Conversas de outras empresas — não devem aparecer para usuários do tenant t-1.
  { id: "cv-7", tenantId: "t-2", channelId: "c-5", contactId: "ct-1", status: "open", unreadCount: 1, assignedTo: "u-5", lastMessageAt: hour(1), tags: [] },
  { id: "cv-8", tenantId: "t-3", channelId: "c-6", contactId: "ct-2", status: "waiting", unreadCount: 0, lastMessageAt: hour(5), tags: [] },
];

export const messagesByConversation: Record<string, Message[]> = {
  "cv-1": [
    { id: "m-1", conversationId: "cv-1", direction: "in", type: "text", text: "Olá! Tenho interesse no plano Pro.", status: "read", createdAt: min(40) },
    { id: "m-2", conversationId: "cv-1", direction: "out", type: "text", text: "Oi João! Posso te ajudar 😊", status: "read", createdAt: min(38), authorName: "Ana Souza" },
    { id: "m-3", conversationId: "cv-1", direction: "out", type: "image", mediaUrl: "https://images.unsplash.com/photo-1551434678-e076c223a692?w=600", text: "Segue uma visão geral do plano.", status: "read", createdAt: min(35), authorName: "Ana Souza" },
    { id: "m-4", conversationId: "cv-1", direction: "in", type: "audio", durationSeconds: 18, mimeType: "audio/ogg", status: "read", createdAt: min(20) },
    { id: "m-5", conversationId: "cv-1", direction: "out", type: "document", fileName: "Proposta-Pro.pdf", mimeType: "application/pdf", fileSize: 184_320, status: "delivered", createdAt: min(10), authorName: "Ana Souza" },
    { id: "m-6", conversationId: "cv-1", direction: "in", type: "text", text: "Recebi, vou analisar e te respondo!", status: "read", createdAt: min(2) },
  ],
  "cv-2": [
    { id: "m-7", conversationId: "cv-2", direction: "in", type: "text", text: "Boa tarde, vocês atendem aos sábados?", status: "delivered", createdAt: min(12) },
    { id: "m-8", conversationId: "cv-2", direction: "in", type: "text", text: "Preciso confirmar antes de ir até a loja", status: "delivered", createdAt: min(10) },
    { id: "m-9", conversationId: "cv-2", direction: "in", type: "image", mediaUrl: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=600", status: "delivered", createdAt: min(9) },
    { id: "m-10", conversationId: "cv-2", direction: "in", type: "text", text: "Esse é o produto que vi no site", status: "delivered", createdAt: min(8) },
  ],
  "cv-3": [
    { id: "m-11", conversationId: "cv-3", direction: "in", type: "text", text: "Bom dia!", status: "read", createdAt: hour(2) },
    { id: "m-12", conversationId: "cv-3", direction: "out", type: "text", text: "Bom dia, Pedro! Como posso ajudar?", status: "read", createdAt: hour(2), authorName: "Bruno Lima" },
    { id: "m-13", conversationId: "cv-3", direction: "in", type: "video", mediaUrl: "https://www.w3schools.com/html/mov_bbb.mp4", mimeType: "video/mp4", fileSize: 1_048_576, status: "read", createdAt: min(40) },
    { id: "m-14", conversationId: "cv-3", direction: "out", type: "internal", text: "Atenção: cliente recorrente, oferecer desconto.", status: "read", createdAt: min(38), authorName: "Carla Dias", isInternalNote: true },
    { id: "m-15", conversationId: "cv-3", direction: "out", type: "text", text: "Recebi o vídeo, vou verificar 👍", status: "read", createdAt: min(34), authorName: "Bruno Lima" },
  ],
  "cv-4": [
    { id: "m-16", conversationId: "cv-4", direction: "in", type: "text", text: "Oi, segunda parcela já caiu?", status: "read", createdAt: hour(3) },
    { id: "m-17", conversationId: "cv-4", direction: "out", type: "text", text: "Sim, Juliana! Compensou hoje pela manhã.", status: "read", createdAt: hour(2), authorName: "Ana Souza" },
  ],
  "cv-5": [
    { id: "m-18", conversationId: "cv-5", direction: "in", type: "text", text: "Obrigado, atendimento finalizado.", status: "read", createdAt: hour(20) },
  ],
  "cv-6": [
    { id: "m-19", conversationId: "cv-6", direction: "in", type: "text", text: "Bom dia, segue o relatório de ontem.", status: "read", createdAt: hour(28) },
    { id: "m-20", conversationId: "cv-6", direction: "in", type: "document", fileName: "Relatorio-Diario.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileSize: 42_240, status: "read", createdAt: hour(28) },
  ],
};

export const dashboardMetrics = {
  openConversations: conversations.filter(c => c.status === "open").length,
  waiting: conversations.filter(c => c.status === "waiting").length,
  finishedToday: 12,
  avgResponseMinutes: 3.4,
  messagesIn: 248,
  messagesOut: 196,
  channelsConnected: channels.filter(c => c.status === "connected").length,
  channelsTotal: channels.length,
  activeAutomations: 3,
  webhookErrors24h: 2,
};

export const internalChats = [
  { id: "ic-1", name: "Geral", members: 4, lastMessage: "Equipe, reunião 16h!", lastAt: min(15) },
  { id: "ic-2", name: "Suporte N2", members: 2, lastMessage: "Bug no canal 3 resolvido", lastAt: hour(1) },
  { id: "ic-3", name: "Comercial", members: 3, lastMessage: "Fechamos com a Acme 🎉", lastAt: hour(4) },
];

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const diff = (today.getTime() - d.getTime()) / 86_400_000;
  if (diff < 7) return d.toLocaleDateString("pt-BR", { weekday: "short" });
  return d.toLocaleDateString("pt-BR");
}

export function formatBytes(b?: number): string {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(1)} MB`;
}

export function getContact(id: string) {
  return contacts.find(c => c.id === id)!;
}
export function getChannel(id: string) {
  return channels.find(c => c.id === id)!;
}
export function getUser(id?: string) {
  return id ? users.find(u => u.id === id) : undefined;
}
export function getTenant(id?: string) {
  return id ? tenants.find(t => t.id === id) : undefined;
}
