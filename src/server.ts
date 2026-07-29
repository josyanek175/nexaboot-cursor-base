import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import {
  isDatabaseBootstrapUnavailable,
  waitForDatabaseReady,
} from "./lib/pg.server";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

/**
 * Cada request aguarda o bootstrap. A Promise é reutilizada enquanto
 * pending/sucesso; após falha + cooldown, uma nova tentativa é permitida.
 */
async function waitForDatabaseReadyOnRequest(): Promise<void> {
  return waitForDatabaseReady();
}

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

function databaseUnavailableResponse(): Response {
  return Response.json(
    { error: "database_initialization_unavailable" },
    { status: 503 },
  );
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
    try {
      const path = new URL(request.url).pathname;
      const tWait0 = Date.now();
      await waitForDatabaseReadyOnRequest();
      const waitMs = Date.now() - tWait0;
      if (waitMs > 1000) {
        console.log("[DB_BOOTSTRAP_WAIT]", { path, waitMs });
      }
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      if (isDatabaseBootstrapUnavailable(error)) {
        console.error("[DB_BOOTSTRAP_REQUEST_BLOCKED]", {
          path: new URL(request.url).pathname,
        });
        return databaseUnavailableResponse();
      }
      // Bootstrap pode rejeitar com o wrapper genérico; também trate mensagem.
      if (
        error instanceof Error &&
        error.message === "database_initialization_unavailable"
      ) {
        console.error("[DB_BOOTSTRAP_REQUEST_BLOCKED]", {
          path: new URL(request.url).pathname,
        });
        return databaseUnavailableResponse();
      }
      console.error(error);
      return brandedErrorResponse();
    }
  },
};
