import { sql } from "@/lib/pg.server";
import { resolveSession } from "@/lib/session.server";
import { workspaceFromPath } from "@/lib/workspace-path";

/** A workspace URL is an extra restriction, never a source of authorization. */
export async function workspaceAccessResponse(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (/^\/(assets|_build|_server|api\/(webhooks|public)|webhook)(\/|$)/.test(url.pathname))
    return null;
  let slug = workspaceFromPath(url.pathname);
  if (!slug && url.pathname.startsWith("/api/")) {
    const referrer = request.headers.get("referer");
    try {
      const ref = referrer ? new URL(referrer) : null;
      if (ref?.origin === url.origin) slug = workspaceFromPath(ref.pathname);
    } catch {
      /* A malformed referrer never selects a company. */
    }
  }
  if (!slug) return null;
  const companies = await sql<{ id: string }[]>`SELECT c.id FROM public.companies c
    WHERE to_jsonb(c)->>'slug'=${slug} AND c.active=true LIMIT 1`;
  const companyId = companies[0]?.id;
  if (!companyId) return new Response("Ambiente da empresa não encontrado.", { status: 404 });
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)nexa_session=([^;]+)/)?.[1];
  if (!cookie) return null; // The usual login page handles authentication.
  let token: string;
  try {
    token = decodeURIComponent(cookie);
  } catch {
    return new Response("Sessão inválida.", { status: 401 });
  }
  const session = await resolveSession(token);
  if (session.status !== "ok") return null;
  const users = await sql<{ company_id: string | null }[]>`SELECT company_id FROM public.users
    WHERE id=${session.session.userId}::uuid AND active=true LIMIT 1`;
  // Platform operators use their normal console. A scoped company URL never grants global access.
  if (users[0]?.company_id !== companyId)
    return new Response("Sua conta não tem acesso ao ambiente desta empresa.", { status: 403 });
  return null;
}
