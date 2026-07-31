import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import {
  bootstrapDatabaseSchema,
  isDatabaseSchemaBootstrapEnabled,
  PG_POOL_MAX,
} from "./lib/pg.server";

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

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    // Bootstrap NÃO é reiniciado aqui — só no load do módulo (acima).
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return brandedErrorResponse();
    }
  },
};
