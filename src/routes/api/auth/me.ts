import { createFileRoute } from "@tanstack/react-router";
import { getCookie } from "@tanstack/react-start/server";
import { sql, ensureSchema } from "@/lib/pg.server";
import {
  getSessionUserId,
  buildClearSetCookie,
  COOKIE_NAME,
} from "@/lib/session.server";
import { buildOperationalCompanyClearCookie } from "@/lib/operational-company.server";
import { getCurrentUserCompanyInfo, NO_COMPANY_MESSAGE, PLATFORM_NO_COMPANY_MESSAGE } from "@/lib/company.server";
import { isPlatformRole } from "@/lib/platform-roles";
import { buildAuthUserResponse } from "@/lib/auth-user";

export const Route = createFileRoute("/api/auth/me")({
  server: {
    handlers: {
      GET: async () => {
        await ensureSchema();

        // Diagnóstico do ciclo do cookie de sessão.
        const rawCookie = getCookie(COOKIE_NAME);
        const uid = getSessionUserId();
        console.log("[ME_SESSION_CHECK]", {
          cookieReceived: !!rawCookie,
          cookieName: COOKIE_NAME,
          sessionResolved: !!uid,
          userId: uid,
        });

        if (!uid) {
          // cookieReceived=false  -> navegador não enviou o cookie (Secure/SameSite/domínio/credentials)
          // cookieReceived=true   -> cookie chegou mas a assinatura/SESSION_SECRET não confere
          return Response.json(
            {
              user: null,
              diag: { cookieReceived: !!rawCookie, sessionResolved: false },
            },
            { status: 200 },
          );
        }

        const rows = await sql()`
          SELECT id, email, name, role, tenant_id, active
          FROM public.users
          WHERE id = ${uid}
          LIMIT 1
        `;
        const u = rows[0];
        if (!u || u.active === false) {
          console.log("[ME_USER_INVALID]", { userId: uid, found: !!u, active: u?.active });
          return Response.json(
            { user: null, diag: { cookieReceived: true, sessionResolved: true, userActive: u?.active ?? null } },
            { headers: { "Set-Cookie": buildClearSetCookie() } },
          );
        }

        // Empresa (isolamento oficial por company_id). O front usa company_valid
        // para bloquear os módulos operacionais quando não há empresa válida.
        const company = await getCurrentUserCompanyInfo(uid);

        // SUPER_ADMIN e TI têm acesso de PLATAFORMA: podem entrar mesmo sem
        // empresa, mas os módulos operacionais continuam exigindo empresa válida.
        const platformAccess = isPlatformRole(u.role);

        // Mensagem conforme o perfil quando não há empresa válida.
        const companyMessage = company.companyValid
          ? null
          : platformAccess
            ? PLATFORM_NO_COMPANY_MESSAGE
            : NO_COMPANY_MESSAGE;

        console.log("[ME_OK]", {
          userId: u.id,
          email: u.email,
          tenant_id: u.tenant_id,
          company_id: company.companyId,
          company_valid: company.companyValid,
          platform_access: platformAccess,
        });
        return Response.json({
          user: buildAuthUserResponse(
            {
              id: u.id,
              email: u.email,
              name: u.name,
              role: u.role,
              tenant_id: u.tenant_id,
            },
            company,
            platformAccess,
          ),
          ...(companyMessage ? { company_message: companyMessage } : {}),
        });
      },
      POST: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("action") === "logout") {
          console.log("[ME_LOGOUT]");
          const headers = new Headers();
          headers.append("Set-Cookie", buildClearSetCookie());
          headers.append("Set-Cookie", buildOperationalCompanyClearCookie());
          return Response.json({ ok: true }, { headers });
        }
        return Response.json({ error: "unknown_action" }, { status: 400 });
      },
    },
  },
});
