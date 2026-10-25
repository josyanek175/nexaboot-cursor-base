import { getSessionUserId } from "@/lib/session.server";
import { getSql } from "@/lib/pg.server";
import { isPlatformRole } from "@/lib/platform-roles";

/** Global diagnostics contain multiple companies; never expose them publicly. */
export async function requirePlatformDiagnostics(): Promise<Response | null> {
  const uid = getSessionUserId();
  if (!uid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const users =
    await getSql()`SELECT role FROM public.users WHERE id=${uid}::uuid AND active=true LIMIT 1`;
  return users[0] && isPlatformRole(users[0].role)
    ? null
    : Response.json({ error: "forbidden" }, { status: 403 });
}
