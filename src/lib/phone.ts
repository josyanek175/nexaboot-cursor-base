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

/**
 * Chave canônica para COMPARAR/DEDUPLICAR números, tratando a variação do nono
 * dígito de celulares brasileiros como equivalente:
 *   55 + DDD(2) + 8 dígitos        ≡  55 + DDD(2) + 9 + 8 dígitos
 * A forma canônica é SEM o nono dígito (12 dígitos), então:
 *   553496692096  → 553496692096
 *   5534996692096 → 553496692096
 * Números não-BR (ou fora do padrão) retornam apenas os dígitos.
 */
export function normalizePhoneForMatch(raw: unknown): string {
  const d = normalizePhone(raw);
  // 55 + DDD(2) + 9 + 8 = 13 dígitos, com '9' logo após o DDD → remove o '9'.
  if (d.length === 13 && d.startsWith("55") && d[4] === "9") {
    return d.slice(0, 4) + d.slice(5);
  }
  return d;
}

/**
 * Variantes equivalentes de um número (com e sem o nono dígito), para buscas
 * por igualdade. Sempre inclui os dígitos originais.
 *   553496692096  → ["553496692096", "5534996692096"]
 *   5534996692096 → ["5534996692096", "553496692096"]
 */
export function getPhoneVariants(raw: unknown): string[] {
  const d = normalizePhone(raw);
  const set = new Set<string>();
  if (d) set.add(d);
  if (d.startsWith("55")) {
    if (d.length === 13 && d[4] === "9") {
      set.add(d.slice(0, 4) + d.slice(5)); // sem o nono dígito
    } else if (d.length === 12) {
      set.add(d.slice(0, 4) + "9" + d.slice(4)); // com o nono dígito
    }
  }
  return [...set];
}
