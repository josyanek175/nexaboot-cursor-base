import {
  getSessionToken,
  verifySessionToken,
  sessionPredatesPasswordChange,
  buildClearSetCookie,
} from "@/lib/session.server";
import { getSql } from "@/lib/pg.server";
import { isPlatformRole } from "@/lib/platform-roles";

/** Global diagnostics require a current session and an active platform role. */
export async function requirePlatformDiagnostics(): Promise<Response | null> {
  const token = getSessionToken();
  const uid = token ? verifySessionToken(token) : null;
  if (!token || !uid) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const users = await getSql()`
      SELECT role, to_jsonb(u)->>'password_changed_at' AS password_changed_at
      FROM public.users u WHERE id=${uid}::uuid AND active=true LIMIT 1
    `;
    if (users[0] && sessionPredatesPasswordChange(token, users[0].password_changed_at)) {
      return Response.json(
        { error: "session_expired" },
        {
          status: 401,
          headers: {
            "Set-Cookie": buildClearSetCookie(),
            "Cache-Control": "private, no-store",
          },
        },
      );
    }
    return users[0] && isPlatformRole(users[0].role)
      ? null
      : Response.json({ error: "forbidden" }, { status: 403 });
  } catch {
    return Response.json(
      { error: "authorization_unavailable" },
      {
        status: 503,
        headers: {
          "Cache-Control": "private, no-store",
          "Retry-After": "5",
        },
      },
    );
  }
}
