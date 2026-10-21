// Serve mídia armazenada como base64 em public.messages.media_base64.
// Aceita id interno (uuid) ou external_id como fallback.
//
// Isolamento oficial por company_id: a mídia só é servida se a mensagem
// pertencer a uma conversa da empresa do usuário logado. Sem isso, qualquer
// UUID/external_id vazaria mídia de outra empresa. As tags <img>/<audio>
// enviam o cookie de sessão (same-origin), então a checagem funciona.

import { createFileRoute } from "@tanstack/react-router";
import { sql } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { downloadMetaMedia } from "@/lib/meta-media-download.server";
import { loadChannelForCompany } from "@/lib/whatsapp/whatsapp-provider-router.server";
import { resolveStoredMetaMedia } from "@/lib/stored-meta-media";
import { messageMediaContentDisposition } from "@/lib/message-media.server";

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

        // O JOIN com conversations garante o escopo da empresa (nunca outra).
        const rows = isUuid
          ? await s<any[]>`
              SELECT m.id, m.media_base64, m.mime_type, m.media_mimetype,
                     m.media_filename, m.media_error, m.raw_payload, c.whatsapp_channel_id
              FROM public.messages m
              JOIN public.conversations c ON c.id = m.conversation_id
              WHERE (m.id = ${messageId}::uuid OR m.external_id = ${messageId})
                AND c.company_id = ${companyId}::uuid
              LIMIT 1
            `
          : await s<any[]>`
              SELECT m.id, m.media_base64, m.mime_type, m.media_mimetype,
                     m.media_filename, m.media_error, m.raw_payload, c.whatsapp_channel_id
              FROM public.messages m
              JOIN public.conversations c ON c.id = m.conversation_id
              WHERE m.external_id = ${messageId}
                AND c.company_id = ${companyId}::uuid
              LIMIT 1
            `;

        const msg = rows[0];
        if (!msg) return jsonErr({ error: "Mensagem não encontrada", requestedId: messageId }, 404);

        if (!msg.media_base64) {
          const media = resolveStoredMetaMedia(msg.raw_payload);
          const channel =
            media && msg.whatsapp_channel_id
              ? await loadChannelForCompany(msg.whatsapp_channel_id, companyId)
              : null;
          if (media && channel?.channelType === "meta" && channel.phoneNumberId) {
            try {
              const downloaded = await downloadMetaMedia({
                channelId: channel.id,
                companyId,
                phoneNumberId: channel.phoneNumberId,
                mediaId: media.id,
                mediaType: media.type,
                messageId: msg.id,
                mimeHint: media.mimeType,
                filenameHint: media.filename,
              });
              if (downloaded.ok) {
                await s`
                  UPDATE public.messages m
                  SET media_base64 = ${downloaded.base64}, mime_type = ${downloaded.mimeType},
                      media_mimetype = ${downloaded.mimeType}, media_error = NULL,
                      media_size = ${downloaded.fileSize},
                      media_url = ${`/api/messages/${msg.id}/media`}
                  FROM public.conversations c
                  WHERE m.id = ${msg.id}::uuid AND c.id = m.conversation_id
                    AND c.company_id = ${companyId}::uuid AND m.media_base64 IS NULL
                `;
                msg.media_base64 = downloaded.base64;
                msg.mime_type = downloaded.mimeType;
              }
            } catch {
              console.error("[MESSAGE_MEDIA_RECOVERY_FAILED]", { messageId: msg.id });
            }
          }
        }
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
          headers["Content-Disposition"] = messageMediaContentDisposition(
            mime,
            msg.media_filename ?? null,
          );
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
      },
    },
  },
});
