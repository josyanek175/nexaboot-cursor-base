// Normalização ÚNICA de telefone do NexaBoot.
//
// Regra (igual em webhook, criação/edição/importação/busca de contato e início
// de conversa): remover jids do WhatsApp (@s.whatsapp.net, @c.us, @lid),
// espaços, parênteses, hífen, "+" e qualquer caractere não numérico.
// Comparar e salvar SEMPRE apenas dígitos.
//
// Arquivo puro (sem dependências de servidor) para poder ser usado tanto no
// backend quanto no frontend.

export type NormalizePhoneE164Options = {
  /** Quando informado, números locais BR (sem DDI) podem receber prefixo 55. */
  defaultCountry?: "BR";
};

const E164_MIN = 8;
const E164_MAX = 15;

/** Remove sufixos WhatsApp e caracteres não numéricos. */
export function normalizePhone(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw)
    .replace(/@s\.whatsapp\.net/gi, "")
    .replace(/@c\.us/gi, "")
    .replace(/@lid/gi, "")
    .replace(/\D+/g, "");
}

/** Valida comprimento E.164 (somente dígitos). */
export function isValidE164Digits(phone: string): boolean {
  return /^\d{8,15}$/.test(phone);
}

function isBrazilLocalMobile(digits: string): boolean {
  return /^\d{2}9\d{8}$/.test(digits);
}

function isBrazilLocalLandline(digits: string): boolean {
  if (!/^\d{2}\d{8}$/.test(digits)) return false;
  const ddd = Number(digits.slice(0, 2));
  if (ddd < 11 || ddd > 99) return false;
  // Reservado NANP (555…) sem DDI — não tratar como BR local.
  if (digits.startsWith("555")) return false;
  return true;
}

function hasExplicitCountryCode(digits: string): boolean {
  if (digits.startsWith("55") && digits.length >= 12) return true;
  if (digits.startsWith("1") && digits.length >= 11) return true;
  if (digits.startsWith("351") && digits.length >= 12) return true;
  if (digits.startsWith("54") && digits.length >= 12) return true;
  if (digits.startsWith("44") && digits.length >= 10) return true;
  if (digits.length >= 12) return true;
  return false;
}

/**
 * Normaliza para dígitos E.164, preservando DDI internacional.
 * Nunca converte +1… em +55….
 * Com defaultCountry=BR, completa 55 apenas para padrões claramente locais BR.
 */
export function normalizePhoneE164(
  raw: unknown,
  options?: NormalizePhoneE164Options,
): string {
  const digits = normalizePhone(raw);
  if (!digits) return "";

  if (hasExplicitCountryCode(digits)) {
    return digits;
  }

  if (options?.defaultCountry === "BR") {
    if (isBrazilLocalMobile(digits) || isBrazilLocalLandline(digits)) {
      return `55${digits}`;
    }
  }

  return digits;
}

/** Formatação amigável para exibição (não altera valor armazenado). */
export function formatPhoneDisplay(phone: string): string {
  const digits = normalizePhone(phone);
  if (!digits) return "";

  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    if (rest.length === 8) {
      return `+55 ${ddd} ${rest.slice(0, 4)}-${rest.slice(4)}`;
    }
    if (rest.length === 9) {
      return `+55 ${ddd} ${rest.slice(0, 5)}-${rest.slice(5)}`;
    }
  }

  if (digits.startsWith("1") && digits.length === 11) {
    const area = digits.slice(1, 4);
    const exchange = digits.slice(4, 7);
    const line = digits.slice(7);
    return `+1 ${area} ${exchange}-${line}`;
  }

  if (digits.startsWith("351") && digits.length === 12) {
    return `+351 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }

  return `+${digits}`;
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

export { E164_MIN, E164_MAX };
