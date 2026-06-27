// Store global de contadores de não-lidas por seção, usado pela sidebar.
// Não usa redux/zustand — apenas um listener leve.

export type UnreadKey = "atendimento" | "internal";
type Counts = Record<UnreadKey, number>;

const counts: Counts = { atendimento: 0, internal: 0 };
const listeners = new Set<(c: Counts) => void>();

export function getUnread(): Counts {
  return { ...counts };
}

export function setUnread(key: UnreadKey, n: number) {
  const next = Math.max(0, Math.floor(n));
  if (counts[key] === next) return;
  counts[key] = next;
  listeners.forEach((l) => l({ ...counts }));
}

export function subscribeUnread(cb: (c: Counts) => void): () => void {
  listeners.add(cb);
  cb({ ...counts });
  return () => {
    listeners.delete(cb);
  };
}
