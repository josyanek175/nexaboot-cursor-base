// Comunicação Interna — 100% separada do atendimento WhatsApp.
// Não toca em Meta, Evolution, billing ou tabela `messages`.

import { users } from "./mocks";

export type InternalChatType = "direct" | "group" | "broadcast";
export type PresenceStatus = "online" | "away" | "offline";

export interface InternalMessage {
  id: string;
  chatId: string;
  tenantId: string;
  authorId: string;
  body: string;
  createdAt: string;
  // Mídia opcional: preenchida quando a API retornar data_url/base64.
  mediaUrl?: string;
  mediaType?: "image" | "audio" | "video" | "document";
  mediaMime?: string;
  fileName?: string;
}


export interface InternalChat {
  id: string;
  tenantId: string;          // ESSENCIAL: isola conversas internas por empresa.
  type: InternalChatType;
  name: string;
  memberIds: string[];
  unread: number;
  lastAt: string;
}

const BASE_NOW = Date.parse("2026-05-19T22:00:00.000Z");
const m = (min: number) => new Date(BASE_NOW - min * 60_000).toISOString();

export const presence: Record<string, PresenceStatus> = {
  "u-1": "online",
  "u-2": "online",
  "u-3": "away",
  "u-4": "offline",
};

export const internalChatsFull: InternalChat[] = [
  { id: "ic-1", tenantId: "t-1", type: "group", name: "Geral", memberIds: ["u-1", "u-2", "u-3", "u-4"], unread: 2, lastAt: m(5) },
  { id: "ic-2", tenantId: "t-1", type: "group", name: "Suporte N2", memberIds: ["u-2", "u-4"], unread: 0, lastAt: m(60) },
  { id: "ic-3", tenantId: "t-1", type: "group", name: "Comercial", memberIds: ["u-1", "u-3"], unread: 1, lastAt: m(120) },
  { id: "ic-4", tenantId: "t-1", type: "direct", name: "Bruno Lima", memberIds: ["u-1", "u-2"], unread: 0, lastAt: m(15) },
  { id: "ic-5", tenantId: "t-1", type: "direct", name: "Carla Dias", memberIds: ["u-1", "u-3"], unread: 3, lastAt: m(8) },
  { id: "ic-6", tenantId: "t-1", type: "broadcast", name: "Avisos da Supervisão", memberIds: ["u-1", "u-2", "u-3", "u-4"], unread: 1, lastAt: m(240) },
  // Outras empresas — visíveis somente aos seus próprios membros.
  { id: "ic-7", tenantId: "t-2", type: "group", name: "Atendimento Clínica", memberIds: ["u-5", "u-6"], unread: 0, lastAt: m(45) },
  { id: "ic-8", tenantId: "t-2", type: "direct", name: "Felipe Castro", memberIds: ["u-5", "u-6"], unread: 1, lastAt: m(30) },
  { id: "ic-9", tenantId: "t-3", type: "group", name: "Loja Verde · Geral", memberIds: ["u-7"], unread: 0, lastAt: m(360) },
];

export const internalMessages: Record<string, InternalMessage[]> = {
  "ic-1": [
    { id: "im-1", chatId: "ic-1", tenantId: "t-1", authorId: "u-3", body: "Bom dia, equipe!", createdAt: m(180) },
    { id: "im-2", chatId: "ic-1", tenantId: "t-1", authorId: "u-2", body: "Bom dia 👋", createdAt: m(178) },
    { id: "im-3", chatId: "ic-1", tenantId: "t-1", authorId: "u-1", body: "Lembrete: reunião às 16h.", createdAt: m(60) },
    { id: "im-4", chatId: "ic-1", tenantId: "t-1", authorId: "u-4", body: "Confirmado!", createdAt: m(5) },
  ],
  "ic-2": [{ id: "im-5", chatId: "ic-2", tenantId: "t-1", authorId: "u-4", body: "Bug no canal 3 resolvido.", createdAt: m(60) }],
  "ic-3": [{ id: "im-6", chatId: "ic-3", tenantId: "t-1", authorId: "u-3", body: "Fechamos com a Acme 🎉", createdAt: m(120) }],
  "ic-4": [
    { id: "im-7", chatId: "ic-4", tenantId: "t-1", authorId: "u-2", body: "Posso pegar a conversa do João?", createdAt: m(20) },
    { id: "im-8", chatId: "ic-4", tenantId: "t-1", authorId: "u-1", body: "Pode sim, te transfiro agora.", createdAt: m(15) },
  ],
  "ic-5": [{ id: "im-9", chatId: "ic-5", tenantId: "t-1", authorId: "u-3", body: "Revisa o relatório pra mim?", createdAt: m(8) }],
  "ic-6": [
    { id: "im-10", chatId: "ic-6", tenantId: "t-1", authorId: "u-3", body: "Equipe, novo SLA entra em vigor amanhã.", createdAt: m(240) },
  ],
  "ic-7": [{ id: "im-11", chatId: "ic-7", tenantId: "t-2", authorId: "u-5", body: "Atender prioridade hoje.", createdAt: m(45) }],
  "ic-8": [{ id: "im-12", chatId: "ic-8", tenantId: "t-2", authorId: "u-5", body: "Pega o telefone do paciente?", createdAt: m(30) }],
  "ic-9": [{ id: "im-13", chatId: "ic-9", tenantId: "t-3", authorId: "u-7", body: "Estoque atualizado.", createdAt: m(360) }],
};

export function getInternalUser(id: string) {
  return users.find((u) => u.id === id);
}
