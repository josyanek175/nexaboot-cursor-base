// Normalização ÚNICA de telefone do NexaBoot.
//
// Regra (igual em webhook, criação/edição/importação/busca de contato e início
// de conversa): remover jids do WhatsApp (@s.whatsapp.net, @c.us, @lid),
// espaços, parênteses, hífen, "+" e qualquer caractere não numérico.
// Comparar e salvar SEMPRE apenas dígitos.
//
// Arquivo puro (sem dependências de servidor) para poder ser usado tanto no
// backend quanto no frontend.
export function normalizePhone(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw)
    .replace(/@s\.whatsapp\.net/gi, "")
    .replace(/@c\.us/gi, "")
    .replace(/@lid/gi, "")
    .replace(/\D+/g, "");
}
