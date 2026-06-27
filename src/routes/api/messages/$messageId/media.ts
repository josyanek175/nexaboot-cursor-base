// Serve mídia armazenada como base64 em public.messages.media_base64.
// Aceita id interno (uuid) ou external_id como fallback.

import { createFileRoute } from "@tanstack/react-router";
import { sql } from "@/lib/pg.server";

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
        const messageId = params.messageId;
        const s = sql();
        const isUuid = UUID_RE.test(messageId);

        const rows = isUuid
          ? await s<any[]>`
              SELECT id, media_base64, mime_type, media_mimetype, media_filename, media_error
              FROM public.messages
              WHERE id = ${messageId}::uuid OR external_id = ${messageId}
              LIMIT 1
            `
          : await s<any[]>`
              SELECT id, media_base64, mime_type, media_mimetype, media_filename, media_error
              FROM public.messages
              WHERE external_id = ${messageId}
              LIMIT 1
            `;

        const msg = rows[0];
        if (!msg) return jsonErr({ error: "Mensagem não encontrada", requestedId: messageId }, 404);

        if (!msg.media_base64) {
          return jsonErr(
            { error: "Mídia não disponível", messageId: msg.id, media_error: msg.media_error },
            404,
          );
        }

        const mime = msg.mime_type ?? msg.media_mimetype ?? "application/octet-stream";
        try {
          const binary = atob(msg.media_base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const headers: Record<string, string> = {
            "Content-Type": mime,
            "Cache-Control": "private, max-age=86400",
          };
          if (msg.media_filename) {
            headers["Content-Disposition"] = `inline; filename="${msg.media_filename.replace(/"/g, "")}"`;
          }
          return new Response(bytes, { status: 200, headers });
        } catch (e) {
          return jsonErr(
            { error: "Falha ao decodificar base64", detail: e instanceof Error ? e.message : String(e) },
            500,
          );
        }
      },
    },
  },
});
