import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import {
  bootstrapDatabaseSchema,
  isDatabaseSchemaBootstrapEnabled,
  PG_POOL_MAX,
  sql,
} from "./lib/pg.server";
import { buildClearSetCookie, verifySessionToken } from "./lib/session.server";
import { accessAllowedNow } from "./lib/access-hours.server";
import {
  ACCESS_OUTSIDE_ALLOWED_HOURS,
  formatAccessHoursUserMessage,
} from "./lib/access-hours";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;
let bootstrapKickoffDone = false;

/**
 * Bootstrap de schema em background — no máximo uma vez por processo.
 * Respeita DB_SCHEMA_BOOTSTRAP_ENABLED (produção: false por padrão).
 * NÃO é chamado a cada request HTTP.
 */
function startDatabaseBootstrapInBackground(): void {
  if (bootstrapKickoffDone) return;
  bootstrapKickoffDone = true;

  const enabled = isDatabaseSchemaBootstrapEnabled();
  if (!enabled) {
    console.log("[DB_BOOTSTRAP_DISABLED]", {
      reason: "policy",
      nodeEnv: process.env.NODE_ENV ?? null,
      flag: process.env.DB_SCHEMA_BOOTSTRAP_ENABLED ?? null,
    });
    console.log("[PG_POOL_CONFIG]", { poolMax: PG_POOL_MAX });
    return;
  }

  console.log("[DB_BOOTSTRAP_ENABLED]", {
    nodeEnv: process.env.NODE_ENV ?? null,
    flag: process.env.DB_SCHEMA_BOOTSTRAP_ENABLED ?? null,
  });
  console.log("[PG_POOL_CONFIG]", { poolMax: PG_POOL_MAX });

  void bootstrapDatabaseSchema().catch((error) => {
    console.error("[DB_BOOTSTRAP_BACKGROUND_ERROR]", {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
  });
}

// Kickoff único no carregamento do módulo (não por request).
startDatabaseBootstrapInBackground();

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => ((m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry)),
    );
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

function readSessionUserId(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)nexa_session=([^;]+)/);
  if (!match?.[1]) return null;
  try {
    return verifySessionToken(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

/** Só o perfil ATENDENTE. Demais perfis seguem sem checagem. */
async function attendantAccessHoursResponse(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/")) return null;
  if (
    path.startsWith("/api/auth/login") ||
    path.startsWith("/api/health") ||
    path.startsWith("/api/webhooks") ||
    path.startsWith("/api/public")
  ) {
    return null;
  }
  const userId = readSessionUserId(request);
  if (!userId) return null;
  try {
    const users = await sql<{ role: string | null; company_id: string | null }[]>`
      SELECT role, company_id FROM public.users WHERE id = ${userId}::uuid AND active = true LIMIT 1
    `;
    const role = String(users[0]?.role ?? "").toUpperCase();
    if (role !== "ATENDENTE") return null;
    const hours = await accessAllowedNow({
      companyId: users[0]?.company_id ?? null,
      role,
    });
    if (hours.allowed) return null;
    const headers = new Headers();
    if (hours.forceLogout) headers.set("Set-Cookie", buildClearSetCookie());
    return Response.json(
      {
        error: ACCESS_OUTSIDE_ALLOWED_HOURS,
        message: formatAccessHoursUserMessage({
          sessionEnded: hours.forceLogout,
          allowedStart: hours.allowedStart,
          allowedEnd: hours.allowedEnd,
          nextWeekdayLabel: hours.nextWeekdayLabel,
          nextTime: hours.nextTime,
        }),
        forceLogout: hours.forceLogout,
        allowedStart: hours.allowedStart,
        allowedEnd: hours.allowedEnd,
        nextWeekdayLabel: hours.nextWeekdayLabel,
        nextTime: hours.nextTime,
      },
      { status: hours.forceLogout ? 401 : 403, headers },
    );
  } catch (error) {
    console.error("[ACCESS_HOURS_GATE_FAIL]", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    // Bootstrap NÃO é reiniciado aqui — só no load do módulo (acima).
    try {
      const blocked = await attendantAccessHoursResponse(request);
      if (blocked) return blocked;
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return brandedErrorResponse();
    }
  },
};
