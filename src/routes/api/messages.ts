import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";

const QuerySchema = z.object({
  conversation_id: z.string().uuid(),
  limit: z.string().optional(),
});

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(n)), MAX_LIMIT);
}

export const Route = createFileRoute("/api/messages")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Isolamento oficial por company_id: sem empresa válida => 401/403.
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
        if (!parsed.success) return Response.json({ error: "invalid_query" }, { status: 400 });

        const limit = parseLimit(parsed.data.limit);
        const s = sql();

        // A conversa precisa pertencer à empresa do usuário (sem isso, qualquer
        // UUID de conversa de outra empresa vazaria mensagens).
        const owns = await s`
          SELECT 1 FROM public.conversations
          WHERE id = ${parsed.data.conversation_id}::uuid
            AND company_id = ${companyId}::uuid
          LIMIT 1
        `;
        if (!owns[0]) return Response.json({ error: "not_found" }, { status: 404 });

        const messages = await s`
          SELECT * FROM (
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
            ORDER BY m.created_at DESC
            LIMIT ${limit}
          ) recent
          ORDER BY created_at ASC
        `;

        return Response.json({ messages, limit, hasMore: messages.length >= limit });
      },
    },
  },
});
