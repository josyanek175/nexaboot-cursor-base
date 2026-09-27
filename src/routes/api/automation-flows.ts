import { createFileRoute } from "@tanstack/react-router";
import {
  deleteAutomationFlow,
  dismissAutomationReminder,
  dispatchAutomationFlow,
  listApprovedTemplates,
  listAutomationFlows,
  listAutomationReminders,
  listCompanyChannels,
  requireAutomationActor,
  resendAutomationReminder,
  saveAutomationFlow,
} from "@/lib/automation-flow.server";

export const Route = createFileRoute("/api/automation-flows")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const view = url.searchParams.get("view") ?? "flows";
        const mode = view === "reminders" ? "reminders" : "manage";
        const actor = await requireAutomationActor(mode);
        if (actor instanceof Response) return actor;
        if (view === "channels") {
          return Response.json({ channels: await listCompanyChannels(actor.companyId) });
        }
        if (view === "templates") {
          const channelId = url.searchParams.get("channelId") ?? "";
          return Response.json({ templates: channelId ? await listApprovedTemplates(actor.companyId, channelId) : [] });
        }
        if (view === "reminders") {
          return Response.json({ reminders: await listAutomationReminders(actor.companyId) });
        }
        return Response.json({ flows: await listAutomationFlows(actor.companyId) });
      },
      POST: async ({ request }) => {
        const body = await request.json().catch(() => null);
        const action = body && typeof body === "object" ? String((body as { action?: string }).action ?? "save") : "save";
        const actor = await requireAutomationActor(action === "resend" || action === "dismiss" ? "reminders" : "manage");
        if (actor instanceof Response) return actor;
        if (action === "delete") return deleteAutomationFlow(actor, String(body.id ?? ""));
        if (action === "dispatch") {
          const ids = Array.isArray(body.contactIds) ? body.contactIds.map(String) : [];
          return dispatchAutomationFlow(actor, String(body.flowId ?? ""), ids);
        }
        if (action === "dismiss") return dismissAutomationReminder(actor, String(body.id ?? ""));
        if (action === "resend") return resendAutomationReminder(actor, String(body.id ?? ""));
        return saveAutomationFlow(actor, body);
      },
    },
  },
});
