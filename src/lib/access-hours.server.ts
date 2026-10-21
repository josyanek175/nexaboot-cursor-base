import { sql } from "@/lib/pg.server";
import {
  ACCESS_PROFILES,
  companyTimezoneOrDefault,
  isAccessProfile,
  describeAccessHoursNotice,
  isInsideAccessSchedule,
  normalizeAccessTime,
  type AccessDayRule,
  type AccessHoursNotice,
  type AccessProfile,
} from "@/lib/access-hours";

export type AccessHoursView = {
  timezone: string;
  adminGeralBypass: boolean;
  profiles: Array<{
    profile: AccessProfile;
    enabled: boolean;
    forceLogoutOutsideSchedule: boolean;
    days: AccessDayRule[];
  }>;
};

type ScheduleRow = {
  id: string;
  profile: string;
  enabled: boolean;
  force_logout_outside_schedule: boolean;
};

type WindowRow = {
  schedule_id: string;
  weekday: number;
  blocked: boolean;
  start_time: string | null;
  end_time: string | null;
};

function emptyDays(): AccessDayRule[] {
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    blocked: false,
    startTime: "08:00",
    endTime: "18:00",
  }));
}

export async function loadAccessHours(companyId: string): Promise<AccessHoursView> {
  const s = sql();
  const companies = await s<{ timezone: string | null }[]>`
    SELECT timezone FROM public.companies WHERE id = ${companyId}::uuid LIMIT 1
  `;
  const settings = await s<{ admin_geral_bypass: boolean }[]>`
    SELECT admin_geral_bypass
    FROM public.company_access_hour_settings
    WHERE company_id = ${companyId}::uuid
    LIMIT 1
  `;
  const schedules = await s<ScheduleRow[]>`
    SELECT id, profile, enabled, force_logout_outside_schedule
    FROM public.company_access_schedules
    WHERE company_id = ${companyId}::uuid
  `;
  const windows = schedules.length
    ? await s<WindowRow[]>`
        SELECT schedule_id, weekday, blocked, start_time::text, end_time::text
        FROM public.company_access_windows
        WHERE schedule_id IN ${s(schedules.map((row) => row.id))}
      `
    : [];

  const windowsBySchedule = new Map<string, AccessDayRule[]>();
  for (const row of windows) {
    const list = windowsBySchedule.get(row.schedule_id) ?? emptyDays();
    const index = list.findIndex((day) => day.weekday === Number(row.weekday));
    if (index >= 0) {
      list[index] = {
        weekday: Number(row.weekday),
        blocked: row.blocked,
        startTime: normalizeAccessTime(row.start_time),
        endTime: normalizeAccessTime(row.end_time),
      };
    }
    windowsBySchedule.set(row.schedule_id, list);
  }

  return {
    timezone: companyTimezoneOrDefault(companies[0]?.timezone),
    adminGeralBypass: settings[0]?.admin_geral_bypass ?? true,
    profiles: ACCESS_PROFILES.filter((profile) => profile === "ATENDENTE").map((profile) => {
      const schedule = schedules.find((row) => row.profile === profile);
      return {
        profile,
        enabled: schedule?.enabled ?? false,
        forceLogoutOutsideSchedule: schedule?.force_logout_outside_schedule ?? false,
        days: schedule ? (windowsBySchedule.get(schedule.id) ?? emptyDays()) : emptyDays(),
      };
    }),
  };
}

export async function accessAllowedNow(opts: {
  companyId: string | null;
  role: string | null;
  now?: Date;
}): Promise<{ allowed: true } | ({ allowed: false; forceLogout: boolean } & AccessHoursNotice)> {
  // Produção: só o perfil ATENDENTE pode ser barrado por horário.
  if (String(opts.role ?? "").toUpperCase() !== "ATENDENTE") return { allowed: true };
  if (!opts.companyId || !isAccessProfile(opts.role)) return { allowed: true };
  try {
    const view = await loadAccessHours(opts.companyId);
    const profile = view.profiles.find((item) => item.profile === opts.role);
    if (!profile?.enabled) return { allowed: true };
    const bypass = opts.role === "ADMIN_GERAL" && view.adminGeralBypass;
    const allowed = isInsideAccessSchedule({
      enabled: true,
      bypass,
      timeZone: view.timezone,
      now: opts.now ?? new Date(),
      days: profile.days,
    });
    if (allowed) return { allowed: true };
    const notice = describeAccessHoursNotice({
      timeZone: view.timezone,
      now: opts.now ?? new Date(),
      days: profile.days,
    });
    return {
      allowed: false,
      forceLogout: profile.forceLogoutOutsideSchedule,
      ...notice,
    };
  } catch (error) {
    console.error("[ACCESS_HOURS_CHECK_FAIL]", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true };
  }
}

