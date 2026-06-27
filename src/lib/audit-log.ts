// Store global e simples de audit_logs (mock).
// Cada entrada terá tenant_id explícito para evidenciar o isolamento multitenant.

import { useSyncExternalStore } from "react";

export type AuditAction =
  | "user.create"
  | "user.update"
  | "user.password_change"
  | "user.password_reset"
  | "user.block"
  | "user.unblock"
  | "user.delete"
  | "tenant.create"
  | "tenant.update"
  | "tenant.toggle_status"
  | "channel.create"
  | "channel.update"
  | "channel.toggle"
  | "channel.test"
  | "channel.qr_generated"
  | "channel.instance_connected"
  | "channel.instance_disconnected"
  | "channel.webhook_configured"
  | "message.sent"
  | "message.received"
  | "message.media_received"
  | "message.send_error"
  | "webhook.received"
  | "webhook.error"
  | "conversation.assign"
  | "conversation.auto_assign"
  | "conversation.transfer"
  | "access.denied"
  | "permission.denied"
  | "auth.login.success"
  | "auth.login.failed"
  | "auth.login.blocked"
  | "auth.logout"
  | "auth.password.reset_requested"
  | "contact.create"
  | "contact.update"
  | "contact.delete"
  | "contact.import";

export interface AuditEntry {
  id: string;
  at: string;
  tenantId: string | null;
  actorId: string;
  actorName: string;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  action: AuditAction;
  result: "success" | "denied" | "error";
  reason?: string;
}

let entries: AuditEntry[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

let counter = 0;

export function pushAudit(e: Omit<AuditEntry, "id" | "at"> & { at?: string }) {
  counter += 1;
  const entry: AuditEntry = {
    id: `al-${Date.now().toString(36)}-${counter}`,
    at: e.at ?? new Date().toISOString(),
    ...e,
  };
  entries = [entry, ...entries];
  emit();
  return entry;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: AuditEntry[] = [];
function getSnapshot() {
  return entries;
}
function getServerSnapshot() {
  return EMPTY;
}

export function useAuditLog(filter?: { tenantId?: string | null; targetType?: string }) {
  const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!filter) return all;
  return all.filter((e) => {
    if (filter.tenantId !== undefined && e.tenantId !== filter.tenantId) return false;
    if (filter.targetType !== undefined && e.targetType !== filter.targetType) return false;
    return true;
  });
}

export function getAuditCount() {
  return entries.length;
}
