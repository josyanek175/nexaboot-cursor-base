// Store compartilhado de grupos internos (localStorage por tenant).
// Usado pela tela "Grupos Internos" (admin) e por "Comunicação Interna".
// Mantém compatibilidade com a chave já usada em comunicacao-interna.tsx.

import { users as mockUsers } from "./mocks";
import type { InternalChat, InternalChatType } from "./internal-mocks";

export interface InternalGroup extends InternalChat {
  active?: boolean; // default true
  description?: string;
  createdAt?: string;
}

const KEY = (tenantId: string) => `nexa.internal.rooms.${tenantId}`;

const DEFAULT_GROUP_NAMES = ["Geral", "Financeiro", "Comercial", "Estoque"];

function readRaw(tenantId: string): InternalGroup[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY(tenantId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as InternalGroup[]) : [];
  } catch {
    return [];
  }
}

function writeRaw(tenantId: string, groups: InternalGroup[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY(tenantId), JSON.stringify(groups));
    window.dispatchEvent(new CustomEvent("nexa:internal-rooms-changed", { detail: { tenantId } }));
  } catch {
    /* quota */
  }
}

/** Garante grupos padrão (Geral/Financeiro/Comercial/Estoque) para o tenant. */
export function ensureDefaultGroups(tenantId: string): InternalGroup[] {
  const current = readRaw(tenantId);
  const have = new Set(current.map((g) => g.name.trim().toLowerCase()));
  const tenantMemberIds = mockUsers
    .filter((u) => u.tenantId === tenantId)
    .map((u) => u.id);
  const toAdd: InternalGroup[] = DEFAULT_GROUP_NAMES.filter(
    (n) => !have.has(n.toLowerCase()),
  ).map((name, i) => ({
    id: `ic-${name.toLowerCase()}-${tenantId}-${Date.now() + i}`,
    tenantId,
    type: "group" as InternalChatType,
    name,
    memberIds: name === "Geral" ? tenantMemberIds : [],
    unread: 0,
    lastAt: new Date().toISOString(),
    active: true,
    createdAt: new Date().toISOString(),
  }));
  if (toAdd.length === 0) return current;
  const merged = [...current, ...toAdd];
  writeRaw(tenantId, merged);
  return merged;
}

export function listGroups(tenantId: string): InternalGroup[] {
  return readRaw(tenantId);
}

export function createGroup(input: {
  tenantId: string;
  name: string;
  description?: string;
  memberIds: string[];
  type?: InternalChatType;
}): InternalGroup {
  const all = readRaw(input.tenantId);
  const group: InternalGroup = {
    id: `ic-${Date.now()}`,
    tenantId: input.tenantId,
    type: input.type ?? "group",
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    memberIds: Array.from(new Set(input.memberIds)),
    unread: 0,
    lastAt: new Date().toISOString(),
    active: true,
    createdAt: new Date().toISOString(),
  };
  writeRaw(input.tenantId, [...all, group]);
  return group;
}

export function updateGroup(
  tenantId: string,
  groupId: string,
  patch: Partial<Omit<InternalGroup, "id" | "tenantId">>,
): InternalGroup | null {
  const all = readRaw(tenantId);
  let updated: InternalGroup | null = null;
  const next = all.map((g) => {
    if (g.id !== groupId) return g;
    updated = {
      ...g,
      ...patch,
      memberIds: patch.memberIds ? Array.from(new Set(patch.memberIds)) : g.memberIds,
    };
    return updated;
  });
  writeRaw(tenantId, next);
  return updated;
}

export function toggleGroupActive(tenantId: string, groupId: string): InternalGroup | null {
  const all = readRaw(tenantId);
  let updated: InternalGroup | null = null;
  const next = all.map((g) => {
    if (g.id !== groupId) return g;
    updated = { ...g, active: !(g.active ?? true) };
    return updated;
  });
  writeRaw(tenantId, next);
  return updated;
}

export function addMembers(tenantId: string, groupId: string, userIds: string[]): InternalGroup | null {
  const g = readRaw(tenantId).find((x) => x.id === groupId);
  if (!g) return null;
  return updateGroup(tenantId, groupId, {
    memberIds: [...g.memberIds, ...userIds],
  });
}

export function removeMember(tenantId: string, groupId: string, userId: string): InternalGroup | null {
  const g = readRaw(tenantId).find((x) => x.id === groupId);
  if (!g) return null;
  return updateGroup(tenantId, groupId, {
    memberIds: g.memberIds.filter((id) => id !== userId),
  });
}

export function subscribeGroups(tenantId: string, cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (!detail || detail.tenantId === tenantId) cb();
  };
  window.addEventListener("nexa:internal-rooms-changed", handler);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("nexa:internal-rooms-changed", handler);
    window.removeEventListener("storage", cb);
  };
}
