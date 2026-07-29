import { createFileRoute } from "@tanstack/react-router";
import { getCookie } from "@tanstack/react-start/server";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/pg.server";
import {
  getSessionUserId,
  buildClearSetCookie,
  COOKIE_NAME,
} from "@/lib/session.server";
import { buildOperationalCompanyClearCookie } from "@/lib/operational-company.server";
import {
  getCurrentUserCompanyInfo,
  NO_COMPANY_MESSAGE,
  PLATFORM_NO_COMPANY_MESSAGE,
} from "@/lib/company.server";
import { isPlatformRole } from "@/lib/platform-roles";
import { buildAuthUserResponse } from "@/lib/auth-user";

export const Route = createFileRoute("/api/auth/me")({
  server: {
    handlers: {
      GET: async () => {
        const requestId = randomUUID();
        const t0 = Date.now();
        let schemaMs = 0;
        let sessionMs = 0;
        let userQueryMs = 0;
        let companyQueryMs = 0;
        let userId: string | null = null;
        let success = false;

        const logTiming = () => {
          console.log("[ME_TIMING]", {
            requestId,
            schemaMs,
            sessionMs,
            userQueryMs,
            companyQueryMs,
            totalMs: Date.now() - t0,
            userId,
            success,
          });
        };

        try {
          // Schema DDL roda no boot (server.ts → bootstrapDatabaseSchema).
          // schemaMs permanece 0 nas rotas HTTP — validação pós-correção.
          schemaMs = 0;

          // Diagnóstico do ciclo do cookie de sessão.
          const rawCookie = getCookie(COOKIE_NAME);
          const tSession0 = Date.now();
          const uid = getSessionUserId();
          sessionMs = Date.now() - tSession0;
          userId = uid;

          console.log("[ME_SESSION_CHECK]", {
            cookieReceived: !!rawCookie,
            cookieName: COOKIE_NAME,
            sessionResolved: !!uid,
            userId: uid,
          });

          if (!uid) {
            // cookieReceived=false  -> navegador não enviou o cookie (Secure/SameSite/domínio/credentials)
            // cookieReceived=true   -> cookie chegou mas a assinatura/SESSION_SECRET não confere
            success = true;
            logTiming();
            return Response.json(
              {
                user: null,
                diag: { cookieReceived: !!rawCookie, sessionResolved: false },
              },
              { status: 200 },
            );
          }

          const tUser0 = Date.now();
          const rows = await sql()`
            SELECT id, email, name, role, tenant_id, active
            FROM public.users
            WHERE id = ${uid}
            LIMIT 1
          `;
          userQueryMs = Date.now() - tUser0;
          const u = rows[0];
          if (!u || u.active === false) {
            console.log("[ME_USER_INVALID]", { userId: uid, found: !!u, active: u?.active });
            success = true;
            logTiming();
            return Response.json(
              {
                user: null,
                diag: {
                  cookieReceived: true,
                  sessionResolved: true,
                  userActive: u?.active ?? null,
                },
              },
              { headers: { "Set-Cookie": buildClearSetCookie() } },
            );
          }

          // Empresa (isolamento oficial por company_id). O front usa company_valid
          // para bloquear os módulos operacionais quando não há empresa válida.
          const tCompany0 = Date.now();
          const company = await getCurrentUserCompanyInfo(uid);
          companyQueryMs = Date.now() - tCompany0;

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
          success = true;
          logTiming();
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
        } catch (err) {
          success = false;
          logTiming();
          throw err;
        }
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
