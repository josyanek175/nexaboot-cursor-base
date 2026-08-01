// GET /api/conversations/:id/messages — mensagens reais de uma conversa.
// Listagem normal: paginada, SEM raw_payload (payloads grandes).
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { withApiTiming } from "@/lib/perf-diag.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(n)), MAX_LIMIT);
}

export const Route = createFileRoute("/api/conversations/$id/messages")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });

        const url = new URL(request.url);
        const limit = parseLimit(url.searchParams.get("limit"));
        // before = ISO timestamp — carrega mensagens mais antigas que este ponto.
        const before = url.searchParams.get("before")?.trim() || null;

        return withApiTiming(
          {
            route: "/api/conversations/:id/messages",
            method: "GET",
            companyId,
            bytesPerResultHint: 400,
          },
          async (perf) => {
            const s = sql();
            const owns = await perf.timedDb("conversation_ownership", () => s`
              SELECT 1 FROM public.conversations
              WHERE id = ${params.id}::uuid AND company_id = ${companyId}::uuid
              LIMIT 1
            `);
            if (!owns[0]) return Response.json({ error: "not_found" }, { status: 404 });

            // Últimas N mensagens (DESC + reordena ASC) — nunca o histórico inteiro.
            const messages = await perf.timedDb("list_messages", () => s`
              SELECT * FROM (
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
                  m.media_size,
                  m.media_caption,
                  m.from_me,
                  m.status,
                  m.created_at,
                  m.sent_by_user_id,
                  m.sent_by_name,
                  m.reaction_emoji,
                  m.reaction_to_message_id,
                  (m.raw_payload IS NOT NULL) AS has_raw_payload
                FROM public.messages m
                WHERE m.conversation_id = ${params.id}::uuid
                  AND (${before}::timestamptz IS NULL OR m.created_at < ${before}::timestamptz)
                ORDER BY m.created_at DESC
                LIMIT ${limit}
              ) recent
              ORDER BY created_at ASC
            `);
            perf.setResultCount(messages.length);
            return Response.json({
              messages,
              limit,
              hasMore: messages.length >= limit,
            });
          },
        );
      },
    },
  },
});
