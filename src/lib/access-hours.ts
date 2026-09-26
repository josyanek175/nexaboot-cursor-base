/** Quando o perfil pode entrar. Não descreve permissões funcionais. */

export const ACCESS_OUTSIDE_ALLOWED_HOURS = "ACCESS_OUTSIDE_ALLOWED_HOURS";
export const ACCESS_OUTSIDE_LOGIN_MESSAGE =
  "Seu perfil não tem acesso ao sistema neste horário.";
export const ACCESS_SESSION_ENDED_MESSAGE =
  "Seu horário de acesso ao sistema terminou. Sua sessão foi encerrada.";
/** Texto amigável de login. O código técnico permanece só no campo `error`. */
export const ACCESS_OUTSIDE_ALLOWED_HOURS_MESSAGE = ACCESS_OUTSIDE_LOGIN_MESSAGE;

const WEEKDAY_LONG: Record<number, string> = {
  1: "segunda-feira",
  2: "terça-feira",
  3: "quarta-feira",
  4: "quinta-feira",
  5: "sexta-feira",
  6: "sábado",
  7: "domingo",
};

export type AccessHoursNotice = {
  allowedStart: string | null;
  allowedEnd: string | null;
  nextWeekdayLabel: string | null;
  nextTime: string | null;
};
export const DEFAULT_ACCESS_TIMEZONE = "America/Sao_Paulo";

export const ACCESS_PROFILES = [
  "SUPER_ADMIN",
  "TI",
  "ADMIN_GERAL",
  "ADMIN_EMPRESA",
  "GERENTE",
  "SUPERVISOR",
  "ATENDENTE",
  "ATENDENTE_GERAL",
] as const;

export type AccessProfile = (typeof ACCESS_PROFILES)[number];

export const ACCESS_PROFILE_LABEL: Record<AccessProfile, string> = {
  SUPER_ADMIN: "Super admin",
  TI: "TI",
  ADMIN_GERAL: "Admin geral",
  ADMIN_EMPRESA: "Admin da empresa",
  GERENTE: "Gerente",
  SUPERVISOR: "Supervisor",
  ATENDENTE: "Atendente",
  ATENDENTE_GERAL: "Atendente geral",
};

/** ISO: 1 = segunda … 7 = domingo. */
export const ACCESS_WEEKDAYS: { weekday: number; label: string }[] = [
  { weekday: 1, label: "Segunda" },
  { weekday: 2, label: "Terça" },
  { weekday: 3, label: "Quarta" },
  { weekday: 4, label: "Quinta" },
  { weekday: 5, label: "Sexta" },
  { weekday: 6, label: "Sábado" },
  { weekday: 7, label: "Domingo" },
];

export type AccessDayRule = {
  weekday: number;
  blocked: boolean;
  startTime: string | null;
  endTime: string | null;
};

const WEEKDAY_SHORT: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function isAccessProfile(value: string): value is AccessProfile {
  return (ACCESS_PROFILES as readonly string[]).includes(value);
}

export function normalizeAccessTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function timeToMinutes(value: string | null): number | null {
  const normalized = normalizeAccessTime(value);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
}

export function companyTimezoneOrDefault(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_ACCESS_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return DEFAULT_ACCESS_TIMEZONE;
  }
}

export function zonedClock(now: Date, timeZone: string): { weekday: number; minutes: number } {
  const zone = companyTimezoneOrDefault(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = WEEKDAY_SHORT[read("weekday")] ?? 0;
  const hour = Number(read("hour"));
  const minute = Number(read("minute"));
  return { weekday, minutes: hour * 60 + minute };
}

export function isInsideAccessSchedule(opts: {
  enabled: boolean;
  bypass: boolean;
  timeZone: string;
  now: Date;
  days: AccessDayRule[];
}): boolean {
  if (!opts.enabled || opts.bypass) return true;
  const clock = zonedClock(opts.now, opts.timeZone);
  const day = opts.days.find((item) => item.weekday === clock.weekday);
  if (!day || day.blocked) return false;
  const start = timeToMinutes(day.startTime);
  const end = timeToMinutes(day.endTime);
  if (start == null || end == null || end <= start) return false;
  return clock.minutes >= start && clock.minutes < end;
}

/** Complemento visual. Não decide se o acesso é permitido. */
export function describeAccessHoursNotice(opts: {
  timeZone: string;
  now: Date;
  days: AccessDayRule[];
}): AccessHoursNotice {
  const empty: AccessHoursNotice = {
    allowedStart: null,
    allowedEnd: null,
    nextWeekdayLabel: null,
    nextTime: null,
  };
  const clock = zonedClock(opts.now, opts.timeZone);
  const today = opts.days.find((day) => day.weekday === clock.weekday);
  const todayStart = timeToMinutes(today?.startTime ?? null);
  const todayEnd = timeToMinutes(today?.endTime ?? null);
  const todayOpen =
    !!today &&
    !today.blocked &&
    todayStart != null &&
    todayEnd != null &&
    todayEnd > todayStart;
  if (todayOpen && clock.minutes < todayEnd) {
    return {
      ...empty,
      allowedStart: normalizeAccessTime(today.startTime),
      allowedEnd: normalizeAccessTime(today.endTime),
    };
  }
  for (let offset = 1; offset <= 7; offset += 1) {
    const weekday = ((clock.weekday - 1 + offset) % 7) + 1;
    const day = opts.days.find((item) => item.weekday === weekday);
    const start = timeToMinutes(day?.startTime ?? null);
    const end = timeToMinutes(day?.endTime ?? null);
    if (!day || day.blocked || start == null || end == null || end <= start) continue;
    return {
      ...empty,
      nextWeekdayLabel: WEEKDAY_LONG[weekday] ?? null,
      nextTime: normalizeAccessTime(day.startTime),
    };
  }
  return empty;
}

export function formatAccessHoursUserMessage(input: {
  sessionEnded?: boolean;
  allowedStart?: string | null;
  allowedEnd?: string | null;
  nextWeekdayLabel?: string | null;
  nextTime?: string | null;
}): string {
  if (input.sessionEnded) return ACCESS_SESSION_ENDED_MESSAGE;
  if (input.allowedStart && input.allowedEnd) {
    return `${ACCESS_OUTSIDE_LOGIN_MESSAGE}\nHorário permitido: ${input.allowedStart} às ${input.allowedEnd}.`;
  }
  if (input.nextWeekdayLabel && input.nextTime) {
    return `${ACCESS_OUTSIDE_LOGIN_MESSAGE}\nPróximo acesso permitido: ${input.nextWeekdayLabel}, às ${input.nextTime}.`;
  }
  return ACCESS_OUTSIDE_LOGIN_MESSAGE;
}
