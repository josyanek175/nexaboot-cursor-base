import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireCompanyId } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import { getSql } from "@/lib/pg.server";
import { AGENDA_ROLES, dateSchema } from "@/lib/clinic-agenda";
import { agendaStore, AgendaError } from "@/lib/clinic-agenda-store.server";

export async function requireAgendaActor() {
  const userId = getSessionUserId();
  if (!userId)
    return Response.json({ message: "Entre novamente para acessar a agenda." }, { status: 401 });
  const companyId = await requireCompanyId(userId);
  if (companyId instanceof Response) return companyId;
  const [user] = await getSql()`SELECT role FROM public.users WHERE id=${userId}::uuid`;
  if (!AGENDA_ROLES.includes(String(user?.role)))
    return Response.json(
      { message: "A agenda piloto está disponível aos administradores da empresa." },
      { status: 403 },
    );
  return { companyId, userId };
}
async function handle(request: Request, write = false) {
  try {
    const actor = await requireAgendaActor();
    if (actor instanceof Response) return actor;
    const store = agendaStore(getSql());
    if (!write) {
      const url = new URL(request.url);
      const from = dateSchema.parse(url.searchParams.get("from"));
      const to = dateSchema.parse(url.searchParams.get("to"));
      const span = (Date.parse(to) - Date.parse(from)) / 86400000;
      if (span < 0 || span > 31) throw new AgendaError(422, "Selecione até 31 dias de cada vez.");
      return Response.json(await store.list(actor.companyId, from, to), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const body = await request.json().catch(() => null);
    const action = z.enum(["professional", "save"]).parse(body?.action);
    const result =
      action === "professional"
        ? await store.createProfessional(actor.companyId, body.data)
        : await store.save(actor.companyId, actor.userId, body.data);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof z.ZodError)
      return Response.json(
        { message: e.issues[0]?.message || "Verifique os campos." },
        { status: 422 },
      );
    if (e instanceof AgendaError)
      return Response.json({ message: e.message }, { status: e.status });
    const code = (e as { code?: string })?.code;
    if (code === "42P01" || code === "42703")
      return Response.json(
        {
          message:
            "A agenda ainda precisa ser preparada no banco de desenvolvimento. Consulte o guia de instalação da agenda.",
          setupRequired: true,
        },
        { status: 503 },
      );
    // No patient details, request body, or SQL in logs/responses.
    console.error("[CLINIC_AGENDA_FAILED]", { code: code || "unknown" });
    return Response.json(
      { message: "Não foi possível acessar a agenda. Tente novamente." },
      { status: 500 },
    );
  }
}
export const Route = createFileRoute("/api/clinic-agenda")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request, true),
    },
  },
});
