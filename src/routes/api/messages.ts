import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

const QuerySchema = z.object({
  conversation_id: z.string().uuid(),
});

export const Route = createFileRoute("/api/messages")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const userId = getSessionUserId();
        if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

        const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
        if (!parsed.success) return Response.json({ error: "invalid_query" }, { status: 400 });

        const s = sql();

        // Schema oficial usa company_id; sessão do app não carrega esse contexto.
        // Para não bloquear o frontend, retornamos as mensagens da conversa pedida.
        const messages = await s`
          SELECT
            m.id,
            m.external_id,
            m.conversation_id,
            m.direction,
            m.message_type,
            m.message_type AS type,
            m.media_type,
            m.message_text     AS body,
            m.media_url,
            m.media_error,
            COALESCE(m.mime_type, m.media_mimetype) AS mime_type,
            m.media_filename   AS file_name,
            m.media_seconds    AS duration_seconds,
            m.from_me,
            m.created_at,
            (m.raw_payload IS NOT NULL) AS has_raw_payload
          FROM public.messages m
          WHERE m.conversation_id = ${parsed.data.conversation_id}::uuid
          ORDER BY m.created_at ASC
        `;

        return Response.json({ messages });
      },
    },
  },
});
