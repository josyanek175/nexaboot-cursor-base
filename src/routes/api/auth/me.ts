import { createFileRoute } from "@tanstack/react-router";
import { getCookie } from "@tanstack/react-start/server";
import { randomUUID } from "node:crypto";
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
import { getDatabaseRuntimeDiag } from "@/lib/pg.server";
import {
  authContextTimeoutResponse,
  isAuthContextTimeout,
  meCompanyStepWithConnectionTiming,
  meUserQueryWithConnectionTiming,
} from "@/lib/auth-me-diag.server";

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
        let userConnectionWaitMs: number | null = null;
        let companyConnectionWaitMs: number | null = null;
        let userId: string | null = null;
        let success = false;

        const logTiming = () => {
          console.log("[ME_TIMING]", {
            requestId,
            schemaMs,
            sessionMs,
            userQueryMs,
            companyQueryMs,
            userConnectionWaitMs,
            companyConnectionWaitMs,
            totalMs: Date.now() - t0,
            userId,
            success,
            ...getDatabaseRuntimeDiag(),
          });
        };

        try {
          // Schema DDL roda em background (server.ts → bootstrapDatabaseSchema).
          // Este handler NÃO aguarda ensure*Schema — consulta o banco diretamente.
          schemaMs = 0;

          // Diagnóstico do ciclo do cookie de sessão.
          const rawCookie = getCookie(COOKIE_NAME);
          const tSession0 = Date.now();
          const uid = getSessionUserId();
          sessionMs = Date.now() - tSession0;
          userId = uid;

          console.log("[ME_SESSION_CHECK]", {
            requestId,
            cookieReceived: !!rawCookie,
            cookieName: COOKIE_NAME,
            sessionResolved: !!uid,
            userId: uid,
            ...getDatabaseRuntimeDiag(),
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

          // ── Etapa DB 1: user query (mesmo SQL; timeout 5s; connection vs query) ──
          const userStep = await meUserQueryWithConnectionTiming(uid, requestId);
          userConnectionWaitMs = userStep.connectionWaitMs;
          userQueryMs = userStep.queryMs;
          const u = userStep.rows[0];
          if (!u || u.active === false) {
            console.log("[ME_USER_INVALID]", {
              requestId,
              userId: uid,
              found: !!u,
              active: u?.active,
            });
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

          // ── Etapa DB 2: empresa (mesma função; timeout 5s) ──
          const companyStep = await meCompanyStepWithConnectionTiming(
            requestId,
            () => getCurrentUserCompanyInfo(uid),
          );
          companyConnectionWaitMs = companyStep.connectionWaitMs;
          companyQueryMs = companyStep.queryMs;
          const company = companyStep.result;

          // SUPER_ADMIN e TI têm acesso de PLATAFORMA: podem entrar mesmo sem
          // empresa, mas os módulos operacionais continuam exigindo empresa válida.
          const platformAccess = isPlatformRole(u.role);

          // Mensagem conforme o perfil quando não há empresa válida.
          const companyMessage = company.companyValid
            ? null
            : platformAccess
              ? PLATFORM_NO_COMPANY_MESSAGE
              : NO_COMPANY_MESSAGE;

          console.log("[ME_STEP_RESPONSE_START]", {
            requestId,
            userId: u.id,
            company_valid: company.companyValid,
          });

          console.log("[ME_OK]", {
            requestId,
            userId: u.id,
            email: u.email,
            tenant_id: u.tenant_id,
            company_id: company.companyId,
            company_valid: company.companyValid,
            platform_access: platformAccess,
          });

          const body = {
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
          };

          console.log("[ME_STEP_RESPONSE_END]", {
            requestId,
            totalMs: Date.now() - t0,
          });

          success = true;
          logTiming();
          return Response.json(body);
        } catch (err) {
          if (isAuthContextTimeout(err)) {
            success = false;
            logTiming();
            console.error("[ME_AUTH_CONTEXT_TIMEOUT]", {
              requestId,
              step: err.step,
              connectionWaitMs: err.connectionWaitMs,
              queryMs: err.queryMs,
              ...getDatabaseRuntimeDiag(),
            });
            return authContextTimeoutResponse();
          }
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
