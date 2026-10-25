import { getSql } from "@/lib/pg.server";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { isPlatformRole } from "@/lib/platform-roles";
import { z } from "zod";
export const TeamAction = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("team"), name: z.string().trim().min(1).max(120) }),
    z.object({ action: z.literal("member"), teamId: z.string().uuid(), userId: z.string().uuid() }),
    z.object({
      action: z.literal("remove_member"),
      teamId: z.string().uuid(),
      userId: z.string().uuid(),
    }),
    z.object({
      action: z.literal("grant"),
      channelId: z.string().uuid(),
      userId: z.string().uuid().optional(),
      teamId: z.string().uuid().optional(),
    }),
    z.object({ action: z.literal("revoke"), grantId: z.string().uuid() }),
    z.object({ action: z.literal("delete_team"), teamId: z.string().uuid() }),
  ])
  .refine((d) => d.action !== "grant" || !!d.userId !== !!d.teamId);
export async function requireTeamManager() {
  const company = await requireCompanyId();
  if (company instanceof Response) return company;
  const actor = await getCurrentUserCompanyInfo();
  if (
    !actor.userId ||
    !(isPlatformRole(actor.role) || ["ADMIN_EMPRESA", "GERENTE"].includes(actor.role ?? ""))
  )
    return Response.json({ error: "forbidden" }, { status: 403 });
  return { companyId: company, userId: actor.userId };
}
export async function saveTeamAction(companyId: string, d: z.infer<typeof TeamAction>) {
  return getSql().begin(async (tx) => {
    if ("teamId" in d && d.teamId) {
      const team =
        await tx`SELECT id FROM public.company_teams WHERE id=${d.teamId}::uuid AND company_id=${companyId}::uuid FOR UPDATE`;
      if (!team[0]) return Response.json({ error: "team_not_found" }, { status: 404 });
    }
    if ("userId" in d && d.userId) {
      const user =
        await tx`SELECT id FROM public.users WHERE id=${d.userId}::uuid AND company_id=${companyId}::uuid AND (${d.action === "remove_member"} OR active=true) FOR SHARE`;
      if (!user[0]) return Response.json({ error: "user_outside_company" }, { status: 403 });
    }
    if (d.action === "team")
      await tx`INSERT INTO public.company_teams(company_id,name) VALUES(${companyId}::uuid,${d.name})`;
    else if (d.action === "member")
      await tx`INSERT INTO public.company_team_members(company_id,team_id,user_id) VALUES(${companyId}::uuid,${d.teamId}::uuid,${d.userId}::uuid) ON CONFLICT DO NOTHING`;
    else if (d.action === "remove_member")
      await tx`DELETE FROM public.company_team_members WHERE company_id=${companyId}::uuid AND team_id=${d.teamId}::uuid AND user_id=${d.userId}::uuid`;
    else if (d.action === "delete_team")
      await tx`DELETE FROM public.company_teams WHERE company_id=${companyId}::uuid AND id=${d.teamId}::uuid`;
    else if (d.action === "revoke")
      await tx`DELETE FROM public.company_channel_grants WHERE company_id=${companyId}::uuid AND id=${d.grantId}::uuid`;
    else {
      const channel =
        await tx`SELECT id FROM public.whatsapp_channels WHERE company_id=${companyId}::uuid AND id=${d.channelId}::uuid AND active=true AND deleted_at IS NULL FOR SHARE`;
      if (!channel[0]) return Response.json({ error: "channel_outside_company" }, { status: 403 });
      await tx`INSERT INTO public.company_channel_grants(company_id,channel_id,user_id,team_id)
        VALUES(${companyId}::uuid,${d.channelId}::uuid,${d.userId ?? null}::uuid,${d.teamId ?? null}::uuid) ON CONFLICT DO NOTHING`;
    }
    return Response.json({ ok: true });
  });
}
