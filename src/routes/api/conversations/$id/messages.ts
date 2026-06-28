// GET /api/conversations/:id/messages — mensagens reais de uma conversa.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/conversations/$id/messages")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        await ensureCrmSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });

        const s = sql();
        const messages = await s`
          SELECT
            m.id,
            m.external_id,
            m.external_message_id,
            m.conversation_id,
            m.direction,
            m.message_type,
            m.message_type AS type,
            m.media_type,
            m.message_text AS body,
            m.media_url,
            m.media_error,
            COALESCE(m.mime_type, m.media_mimetype) AS mime_type,
            m.media_filename AS file_name,
            m.media_seconds  AS duration_seconds,
            m.media_caption,
            m.from_me,
            m.status,
            m.created_at,
            (m.raw_payload IS NOT NULL) AS has_raw_payload
          FROM public.messages m
          WHERE m.conversation_id = ${params.id}::uuid
          ORDER BY m.created_at ASC
        `;
        return Response.json({ messages });
      },
    },
  },
});
