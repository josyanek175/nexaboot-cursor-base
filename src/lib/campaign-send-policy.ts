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

/**
 * Fuso canônico das janelas de campanha (UI/DB gravam horário comercial BR).
 * Nunca usar getHours()/getMinutes() do host — containers PROD costumam ser UTC.
 */
export const CAMPAIGN_TIME_ZONE = "America/Sao_Paulo";

const campaignDateTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CAMPAIGN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export type CampaignZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** Partes de calendário/relógio em America/Sao_Paulo para um instante. */
export function getCampaignZonedParts(date: Date): CampaignZonedParts {
  const parts = campaignDateTimeFmt.formatToParts(date);
  const num = (type: Intl.DateTimeFormatPartTypes): number => {
    const v = parts.find((p) => p.type === type)?.value;
    return v != null ? Number(v) : NaN;
  };
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
    second: num("second"),
  };
}

/** Minutos desde meia-noite em America/Sao_Paulo. */
export function campaignMinutesSinceMidnight(date: Date): number {
  const p = getCampaignZonedParts(date);
  return p.hour * 60 + p.minute;
}

/**
 * Converte data/hora de parede em America/Sao_Paulo para um Instant (Date UTC).
 * Itera o offset (sem dependência externa; cobre UTC−3 estável e eventuais mudanças).
 */
export function campaignZonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  for (let i = 0; i < 4; i += 1) {
    const parts = getCampaignZonedParts(new Date(utcMs));
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    const actual = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    );
    const diff = wanted - actual;
    if (diff === 0) break;
    utcMs += diff;
  }
  return new Date(utcMs);
}

/** schedule_date + window_start (HH:MM) como instante em America/Sao_Paulo. */
export function getCampaignScheduleStart(
  scheduleDate: string | null | undefined,
  windowStart: string | null | undefined,
): Date | null {
  if (!scheduleDate) return null;
  const [y, m, d] = scheduleDate.split("-").map(Number);
  if (!y || !m || !d) return null;
  const startMin = timeToMinutes(windowStart) ?? 0;
  return campaignZonedTimeToUtc(y, m, d, Math.floor(startMin / 60), startMin % 60, 0);
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
  const cur = campaignMinutesSinceMidnight(now);
  if (start <= end) return cur >= start && cur < end;
  // Janela que cruza meia-noite.
  return cur >= start || cur < end;
}

/**
 * Se estiver fora da janela, retorna o próximo instante permitido
 * (mesmo dia se ainda não começou; senão próximo dia no horário inicial).
 * Todos os cálculos de calendário/relógio usam America/Sao_Paulo.
 */
export function nextAllowedSendAt(
  now: Date,
  scheduleDate: string | null | undefined,
  windowStart: string | null | undefined,
  windowEnd: string | null | undefined,
): Date {
  const startMin = timeToMinutes(windowStart) ?? 0;
  const endMin = timeToMinutes(windowEnd);
  const startH = Math.floor(startMin / 60);
  const startM = startMin % 60;

  if (scheduleDate) {
    const scheduleStart = getCampaignScheduleStart(scheduleDate, windowStart);
    if (scheduleStart && now < scheduleStart) return scheduleStart;
  }

  if (endMin != null && !isWithinSendWindow(now, windowStart, windowEnd)) {
    const z = getCampaignZonedParts(now);
    const cur = z.hour * 60 + z.minute;
    if (cur < startMin) {
      return campaignZonedTimeToUtc(z.year, z.month, z.day, startH, startM, 0);
    }
    // Passou do horário final → próximo dia civil em SP no início da janela.
    const nextCivil = new Date(Date.UTC(z.year, z.month - 1, z.day + 1));
    return campaignZonedTimeToUtc(
      nextCivil.getUTCFullYear(),
      nextCivil.getUTCMonth() + 1,
      nextCivil.getUTCDate(),
      startH,
      startM,
      0,
    );
  }

  return new Date(now);
}

export function shouldPauseUntilNextDay(
  now: Date,
  windowEnd: string | null | undefined,
): boolean {
  const endMin = timeToMinutes(windowEnd);
  if (endMin == null) return false;
  const cur = campaignMinutesSinceMidnight(now);
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
