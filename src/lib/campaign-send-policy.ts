/**
 * Política interna de envio de campanhas — "Automático seguro".
 * O cliente NÃO configura ritmo; estes parâmetros são só do sistema.
 */

export const CAMPAIGN_SEND_MODE = "auto_safe" as const;

/** Estratégia MVP de ritmo (não expor na UI). */
export const SAFE_SEND_POLICY = {
  blockSizeMin: 12,
  blockSizeMax: 20,
  messagePauseMsMin: 4_000,
  messagePauseMsMax: 12_000,
  blockPauseMsMin: 75_000, // 1 min 15 s
  blockPauseMsMax: 180_000, // 3 min
  everyNMessages: 100,
  longPauseMsMin: 8 * 60_000,
  longPauseMsMax: 15 * 60_000,
} as const;

export const GREETING_VARIANTS = [
  "Oi {nome}, tudo bem?",
  "Olá {nome}, tudo certo?",
  "Bom dia, {nome}. Tudo bem?",
  "Boa tarde, {nome}. Tudo certo?",
] as const;

export const CLOSING_VARIANTS = [
  "Podemos te ajudar?",
  "Quer que nossa equipe te chame?",
  "Deseja receber mais informações?",
  "Podemos verificar isso com você?",
] as const;

export function randomIntInclusive(min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

export function nextBlockSize(): number {
  return randomIntInclusive(SAFE_SEND_POLICY.blockSizeMin, SAFE_SEND_POLICY.blockSizeMax);
}

export function nextMessagePauseMs(): number {
  return randomIntInclusive(
    SAFE_SEND_POLICY.messagePauseMsMin,
    SAFE_SEND_POLICY.messagePauseMsMax,
  );
}

export function nextBlockPauseMs(): number {
  return randomIntInclusive(SAFE_SEND_POLICY.blockPauseMsMin, SAFE_SEND_POLICY.blockPauseMsMax);
}

export function nextLongPauseMs(): number {
  return randomIntInclusive(SAFE_SEND_POLICY.longPauseMsMin, SAFE_SEND_POLICY.longPauseMsMax);
}

/**
 * Após enviar `sentInCampaign` mensagens, decide a pausa seguinte.
 * - a cada 100: pausa longa
 * - ao fechar bloco: pausa de bloco
 * - senão: pausa entre mensagens
 */
export function nextPauseAfterSend(opts: {
  sentInCampaign: number;
  messagesInCurrentBlock: number;
  blockSize: number;
}): { kind: "message" | "block" | "long"; delayMs: number; nextBlockSize?: number } {
  const { sentInCampaign, messagesInCurrentBlock, blockSize } = opts;

  if (sentInCampaign > 0 && sentInCampaign % SAFE_SEND_POLICY.everyNMessages === 0) {
    return { kind: "long", delayMs: nextLongPauseMs(), nextBlockSize: nextBlockSize() };
  }
  if (messagesInCurrentBlock >= blockSize) {
    return { kind: "block", delayMs: nextBlockPauseMs(), nextBlockSize: nextBlockSize() };
  }
  return { kind: "message", delayMs: nextMessagePauseMs() };
}

/** Parse "HH:MM" ou "HH:MM:SS" → minutos desde meia-noite. */
export function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function isWithinSendWindow(
  now: Date,
  windowStart: string | null | undefined,
  windowEnd: string | null | undefined,
): boolean {
  const start = timeToMinutes(windowStart);
  const end = timeToMinutes(windowEnd);
  if (start == null || end == null) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start <= end) return cur >= start && cur < end;
  // Janela que cruza meia-noite.
  return cur >= start || cur < end;
}

/**
 * Se estiver fora da janela, retorna o próximo instante permitido
 * (mesmo dia se ainda não começou; senão próximo dia no horário inicial).
 */
export function nextAllowedSendAt(
  now: Date,
  scheduleDate: string | null | undefined,
  windowStart: string | null | undefined,
  windowEnd: string | null | undefined,
): Date {
  const startMin = timeToMinutes(windowStart) ?? 0;
  const endMin = timeToMinutes(windowEnd);

  const candidate = new Date(now);

  if (scheduleDate) {
    const [y, m, d] = scheduleDate.split("-").map(Number);
    if (y && m && d) {
      const scheduleStart = new Date(y, m - 1, d, Math.floor(startMin / 60), startMin % 60, 0, 0);
      if (candidate < scheduleStart) return scheduleStart;
    }
  }

  if (endMin != null && !isWithinSendWindow(candidate, windowStart, windowEnd)) {
    const cur = candidate.getHours() * 60 + candidate.getMinutes();
    if (cur < startMin) {
      candidate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      return candidate;
    }
    // Passou do horário final → próximo dia no início da janela.
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
    return candidate;
  }

  return candidate;
}

export function shouldPauseUntilNextDay(
  now: Date,
  windowEnd: string | null | undefined,
): boolean {
  const endMin = timeToMinutes(windowEnd);
  if (endMin == null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= endMin;
}

function applyTags(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, key: string) => {
    const k = key.toLowerCase();
    const raw =
      variables[key] ??
      variables[k] ??
      (k === "nome" ? variables.name ?? variables.Nome : undefined) ??
      (k === "name" ? variables.nome ?? variables.Nome : undefined);
    if (raw == null) return "";
    return String(raw);
  });
}

export type MessageVariation = {
  greeting_variant: string;
  closing_variant: string;
  body_template: string;
  rendered_message: string;
};

/** Monta mensagem final: saudação + corpo do cliente (com tags) + fechamento. */
export function buildVariedMessage(
  bodyTemplate: string,
  variables: Record<string, unknown> = {},
): MessageVariation {
  const greetingTemplate =
    GREETING_VARIANTS[randomIntInclusive(0, GREETING_VARIANTS.length - 1)];
  const closingTemplate =
    CLOSING_VARIANTS[randomIntInclusive(0, CLOSING_VARIANTS.length - 1)];

  const nome =
    String(variables.nome ?? variables.name ?? variables.Nome ?? "").trim() || "olá";
  const vars: Record<string, unknown> = {
    ...variables,
    nome,
    name: String(variables.name ?? variables.nome ?? nome).trim() || nome,
    phone: variables.phone ?? variables.telefone ?? "",
  };

  const greeting = applyTags(greetingTemplate, vars).trim();
  const body = applyTags(bodyTemplate.trim(), vars).trim();
  const closing = applyTags(closingTemplate, vars).trim();

  const parts = [greeting, body, closing].filter((p) => p.length > 0);
  return {
    greeting_variant: greetingTemplate,
    closing_variant: closingTemplate,
    body_template: bodyTemplate,
    rendered_message: parts.join("\n\n"),
  };
}

/** Telefone inválido para campanha (BR básico). */
export function isInvalidCampaignPhone(phoneDigits: string): boolean {
  const p = phoneDigits.replace(/\D/g, "");
  if (p.length < 10 || p.length > 13) return true;
  if (p.startsWith("55") && (p.length < 12 || p.length > 13)) return true;
  return false;
}

export function isOptOutContact(contact: {
  status?: string | null;
  tags?: string[] | null;
}): boolean {
  const st = String(contact.status ?? "").toLowerCase();
  if (st === "opt_out" || st === "optout" || st === "inativo" || st === "merged") return true;
  const tags = contact.tags ?? [];
  return tags.some((t) => {
    const v = String(t).toLowerCase().replace(/\s+/g, "-");
    return v === "opt-out" || v === "optout" || v === "nao-perturbe" || v === "não-perturbe";
  });
}
