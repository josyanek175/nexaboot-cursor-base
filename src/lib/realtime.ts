// Preparação para Supabase Realtime — Fase 5 ativará a integração real.
// Hoje retorna apenas um stub que pode ser substituído sem mudar o consumidor.
//
// Uso futuro:
//   const channel = supabase
//     .channel(`conv:${conversationId}`)
//     .on("postgres_changes", { event: "*", schema: "public", table: "messages",
//        filter: `conversation_id=eq.${conversationId}` }, handler)
//     .subscribe();
//
//   return () => supabase.removeChannel(channel);

export type RealtimeEvent =
  | { type: "message"; payload: unknown }
  | { type: "conversation"; payload: unknown };

export function subscribeToConversation(
  _conversationId: string,
  _handler: (e: RealtimeEvent) => void,
): () => void {
  // no-op em Fase 3 — pronto para conectar ao Supabase em fases futuras.
  return () => {};
}

export function subscribeToInbox(
  _tenantId: string,
  _handler: (e: RealtimeEvent) => void,
): () => void {
  return () => {};
}
