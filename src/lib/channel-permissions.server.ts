import { getSql } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";
import { isPlatformRole } from "@/lib/platform-roles";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";

export async function requireChannelManager() {
  const company = await requireCompanyId();
  if (company instanceof Response) return company;
  const actor = await getCurrentUserCompanyInfo();
  return isPlatformRole(actor.role) || actor.role === "ADMIN_EMPRESA"
    ? company
    : Response.json({ error: "forbidden" }, { status: 403 });
}

/** null = company opted out or administrator; [] = no authorized number. */
export async function allowedChannelIds(
  companyId: string,
  userId = getSessionUserId(),
): Promise<string[] | null> {
  if (!userId) return [];
  const db = getSql();
  const users =
    await db`SELECT role,company_id,active FROM public.users WHERE id=${userId}::uuid AND active=true`;
  const actor = users[0];
  if (!actor || (!isPlatformRole(actor.role) && actor.company_id !== companyId)) return [];
  if (isPlatformRole(actor.role) || actor.role === "ADMIN_EMPRESA") return null;
  // Before rollout there are no per-channel rules. Missing grant tables after
  // settings exist is an error, never an implicit authorization.
  const table = await db`SELECT to_regclass('public.company_operations_settings') AS present`;
  if (!table[0]?.present) return null;
  const settings =
    await db`SELECT restrict_channels FROM public.company_operations_settings WHERE company_id=${companyId}::uuid`;
  if (!settings[0]?.restrict_channels) return null;
  const rows = await db`SELECT DISTINCT g.channel_id FROM public.company_channel_grants g
    JOIN public.whatsapp_channels ch ON ch.id=g.channel_id AND ch.company_id=g.company_id
    WHERE g.company_id=${companyId}::uuid AND ch.active=true AND ch.deleted_at IS NULL
      AND (g.user_id=${userId}::uuid OR EXISTS(SELECT 1 FROM public.company_team_members m
        JOIN public.users u ON u.id=m.user_id AND u.company_id=m.company_id AND u.active=true
        WHERE m.company_id=g.company_id AND m.team_id=g.team_id AND m.user_id=${userId}::uuid))`;
  return rows.map((r) => String(r.channel_id));
}
export async function requireChannelAccess(
  companyId: string,
  channelId: string,
  userId?: string | null,
) {
  const rows =
    await getSql()`SELECT id FROM public.whatsapp_channels WHERE id=${channelId}::uuid AND company_id=${companyId}::uuid`;
  if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
  const allowed = await allowedChannelIds(companyId, userId);
  return allowed === null || allowed.includes(channelId)
    ? null
    : Response.json(
        { error: "channel_forbidden", message: "Este número não está liberado para você." },
        { status: 403 },
      );
}
export async function requireConversationAccess(
  companyId: string,
  conversationId: string,
  userId?: string | null,
) {
  const rows =
    await getSql()`SELECT whatsapp_channel_id FROM public.conversations WHERE id=${conversationId}::uuid AND company_id=${companyId}::uuid`;
  if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
  return requireChannelAccess(companyId, String(rows[0].whatsapp_channel_id), userId);
}
