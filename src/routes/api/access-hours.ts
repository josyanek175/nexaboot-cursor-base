import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session.server";
import { sql } from "@/lib/pg.server";
import { loadAccessHours } from "@/lib/access-hours.server";
import {
  ACCESS_PROFILES,
  companyTimezoneOrDefault,
  isAccessProfile,
  normalizeAccessTime,
} from "@/lib/access-hours";

const MANAGE_ROLES = new Set(["SUPER_ADMIN", "TI", "ADMIN_GERAL", "ADMIN_EMPRESA"]);

const Day = z.object({
  weekday: z.number().int().min(1).max(7),
  blocked: z.boolean(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
});

const Body = z.object({
  timezone: z.string().trim().max(80).nullable(),
  adminGeralBypass: z.boolean(),
  profiles: z.array(
    z.object({
      profile: z.string(),
      enabled: z.boolean(),
      forceLogoutOutsideSchedule: z.boolean(),
      days: z.array(Day).length(7),
    }),
  ),
});

async function requireManager() {
  const userId = getSessionUserId();
  if (!userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const users = await sql<{ role: string; company_id: string | null }[]>`
    SELECT role, company_id FROM public.users WHERE id = ${userId}::uuid LIMIT 1
  `;
  const role = users[0]?.role ?? "";
  const companyId = users[0]?.company_id;
  if (!MANAGE_ROLES.has(role) || !companyId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return { companyId };
}

export const Route = createFileRoute("/api/access-hours")({
  server: {
    handlers: {
      GET: async () => {
        const gate = await requireManager();
        if (gate instanceof Response) return gate;
        const view = await loadAccessHours(gate.companyId);
        return Response.json(view);
      },
      PUT: async ({ request }) => {
        const gate = await requireManager();
        if (gate instanceof Response) return gate;
        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }
        const timezone = companyTimezoneOrDefault(parsed.data.timezone);
        const profiles = parsed.data.profiles.filter((profile) => profile.profile === "ATENDENTE");
        for (const profile of profiles) {
          if (!isAccessProfile(profile.profile)) {
            return Response.json({ error: "invalid_profile" }, { status: 400 });
          }
          for (const day of profile.days) {
            if (day.blocked) continue;
            const start = normalizeAccessTime(day.startTime);
            const end = normalizeAccessTime(day.endTime);
            if (!start || !end || end <= start) {
              return Response.json(
                { error: "invalid_window", message: "Horário final deve ser depois do inicial." },
                { status: 400 },
              );
            }
          }
        }

        const s = sql();
        await s`
          UPDATE public.companies
          SET timezone = ${timezone}
          WHERE id = ${gate.companyId}::uuid
        `;
        await s`
          INSERT INTO public.company_access_hour_settings (company_id, admin_geral_bypass)
          VALUES (${gate.companyId}::uuid, ${parsed.data.adminGeralBypass})
          ON CONFLICT (company_id) DO UPDATE
          SET admin_geral_bypass = EXCLUDED.admin_geral_bypass,
              updated_at = now()
        `;

        for (const profile of parsed.data.profiles.filter((item) => item.profile === "ATENDENTE")) {
          const saved = await s<{ id: string }[]>`
            INSERT INTO public.company_access_schedules (
              company_id, profile, enabled, force_logout_outside_schedule
            ) VALUES (
              ${gate.companyId}::uuid,
              ${profile.profile},
              ${profile.enabled},
              ${profile.forceLogoutOutsideSchedule}
            )
            ON CONFLICT (company_id, profile) DO UPDATE
            SET enabled = EXCLUDED.enabled,
                force_logout_outside_schedule = EXCLUDED.force_logout_outside_schedule,
                updated_at = now()
            RETURNING id
          `;
          const scheduleId = saved[0]?.id;
          if (!scheduleId) continue;
          for (const day of profile.days) {
            const start = day.blocked ? null : normalizeAccessTime(day.startTime);
            const end = day.blocked ? null : normalizeAccessTime(day.endTime);
            await s`
              INSERT INTO public.company_access_windows (
                schedule_id, weekday, blocked, start_time, end_time
              ) VALUES (
                ${scheduleId}::uuid,
                ${day.weekday},
                ${day.blocked},
                ${start}::time,
                ${end}::time
              )
              ON CONFLICT (schedule_id, weekday) DO UPDATE
              SET blocked = EXCLUDED.blocked,
                  start_time = EXCLUDED.start_time,
                  end_time = EXCLUDED.end_time
            `;
          }
        }

        return Response.json(await loadAccessHours(gate.companyId));
      },
    },
  },
});
