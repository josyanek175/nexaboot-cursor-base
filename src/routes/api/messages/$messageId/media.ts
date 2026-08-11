// Serve mídia de public.messages:
//   1) media_base64 (legado / inline)
//   2) storage_key via MEDIA_STORAGE_* (media-worker)
//   3) media_url externa (redirect)
//
// Isolamento oficial por company_id: a mídia só é servida se a mensagem
// pertencer a uma conversa da empresa do usuário logado.

import { createFileRoute } from "@tanstack/react-router";
import { Readable } from "node:stream";
import { sql } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { messageMediaContentDisposition } from "@/lib/message-media.server";
import { createMediaStorage, readMediaStorageConfig } from "@/lib/media-storage.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonErr(body: unknown, status = 404) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/messages/$messageId/media")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const messageId = params.messageId;
        const s = sql();
        const isUuid = UUID_RE.test(messageId);

        const rows = isUuid
          ? await s<any[]>`
              SELECT m.id, m.media_base64, m.mime_type, m.media_mimetype,
                     m.media_filename, m.media_error, m.media_url, m.storage_key,
                     m.media_status
              FROM public.messages m
              JOIN public.conversations c ON c.id = m.conversation_id
              WHERE (m.id = ${messageId}::uuid OR m.external_id = ${messageId})
                AND c.company_id = ${companyId}::uuid
              LIMIT 1
            `
          : await s<any[]>`
              SELECT m.id, m.media_base64, m.mime_type, m.media_mimetype,
                     m.media_filename, m.media_error, m.media_url, m.storage_key,
                     m.media_status
              FROM public.messages m
              JOIN public.conversations c ON c.id = m.conversation_id
              WHERE m.external_id = ${messageId}
                AND c.company_id = ${companyId}::uuid
              LIMIT 1
            `;

        const msg = rows[0];
        if (!msg) return jsonErr({ error: "Mensagem não encontrada", requestedId: messageId }, 404);

        const mime = msg.mime_type ?? msg.media_mimetype ?? "application/octet-stream";
        const headers: Record<string, string> = {
          "Content-Type": mime,
          "Cache-Control": "private, max-age=86400",
        };
        headers["Content-Disposition"] = messageMediaContentDisposition(
          mime,
          msg.media_filename ?? null,
        );

        if (msg.media_base64) {
          try {
            const binary = atob(msg.media_base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return new Response(bytes, { status: 200, headers });
          } catch (e) {
            return jsonErr(
              {
                error: "Falha ao decodificar base64",
                detail: e instanceof Error ? e.message : String(e),
              },
              500,
            );
          }
        }

        if (msg.storage_key) {
          try {
            const storage = createMediaStorage(readMediaStorageConfig());
            const stream = await storage.openReadStream(String(msg.storage_key));
            const webStream = Readable.toWeb(stream as Readable);
            return new Response(webStream as BodyInit, { status: 200, headers });
          } catch (e) {
            console.error("[MEDIA_STORAGE_READ_ERROR]", {
              messageId: msg.id,
              storageKey: msg.storage_key,
              error: e instanceof Error ? e.message : String(e),
            });

            return jsonErr(
              {
                error: "Mídia não disponível no storage",
                messageId: msg.id,
                media_status: msg.media_status ?? null,
                media_error: msg.media_error,
              },
              404,
            );
          }
        }

        if (
          typeof msg.media_url === "string" &&
          /^https?:\/\//i.test(msg.media_url) &&
          !msg.media_url.includes("/api/messages/")
        ) {
          return Response.redirect(msg.media_url, 302);
        }

        return jsonErr(
          {
            error: "Mídia não disponível",
            messageId: msg.id,
            media_status: msg.media_status ?? null,
            media_error: msg.media_error,
          },
          404,
        );
      },
    },
  },
});
