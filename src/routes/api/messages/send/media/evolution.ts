// POST /api/messages/send/media/evolution — envia imagem/áudio REAIS pela
// Evolution (multipart/form-data) e grava a mensagem outbound no banco.
// Campos do form: conversationId (uuid), file (File), caption? (string; só imagem).
//
// Segurança: exige sessão; valida que a conversa é da empresa do usuário; exige
// canal real e conectado; aceita apenas os MIMEs da allowlist; aplica limites de
// tamanho; sanitiza o nome do arquivo (nunca confia no nome do usuário) e não
// expõe caminho interno do servidor. Reaproveita o padrão de mídia já existente
// (base64 em media_base64 + media_url servido por /api/messages/:id/media).
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/webm",
  "audio/wav",
  "audio/mp4",
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // 16 MB

function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "audio/webm":
      return ".webm";
    case "audio/wav":
      return ".wav";
    case "audio/mp4":
      return ".m4a";
    default:
      return "";
  }
}

/** Sanitiza o nome só para exibição/download. Nunca usado como caminho de disco. */
function sanitizeFileName(name: string, mime: string): string {
  const base = (name || "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .trim();
  const safe = cleaned.slice(0, 120);
  return safe || `arquivo${extForMime(mime)}`;
}

export const Route = createFileRoute("/api/messages/send/media/evolution")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return Response.json({ error: "invalid_form" }, { status: 400 });
        }

        const conversationId = String(form.get("conversationId") ?? "");
        const caption = String(form.get("caption") ?? "").slice(0, 1024);
        const file = form.get("file");

        if (!UUID_RE.test(conversationId)) {
          return Response.json({ error: "invalid_conversation_id" }, { status: 400 });
        }
        if (!(file instanceof File)) {
          return Response.json({ error: "missing_file" }, { status: 400 });
        }

        const mime = (file.type || "").toLowerCase();
        const isImage = IMAGE_MIMES.has(mime);
        const isAudio = AUDIO_MIMES.has(mime);
        if (!isImage && !isAudio) {
          return Response.json({ error: "unsupported_type", mime }, { status: 415 });
        }

        const size = file.size;
        if (size <= 0) return Response.json({ error: "empty_file" }, { status: 400 });
        const limit = isImage ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
        if (size > limit) {
          return Response.json({ error: "too_large", limit }, { status: 413 });
        }

        const s = sql();

        // Autoria: usuário logado, restrito à mesma empresa (nunca outra).
        const uid = getSessionUserId();
        const attendantRows = uid
          ? await s<{ id: string; name: string | null }[]>`
              SELECT id, name FROM public.users
              WHERE id = ${uid}::uuid AND company_id = ${companyId}::uuid
              LIMIT 1
            `
          : [];
        const attendant = attendantRows[0] ?? null;

        const rows = await s<
          {
            id: string;
            phone: string | null;
            external_jid: string | null;
            evolution_instance_name: string | null;
            channel_status: string | null;
          }[]
        >`
          SELECT c.id, ct.phone, ct.external_jid,
                 ch.evolution_instance_name, ch.status AS channel_status
          FROM public.conversations c
          JOIN public.contacts ct ON ct.id = c.contact_id
          JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
          WHERE c.id = ${conversationId}::uuid
            AND c.company_id = ${companyId}::uuid
          LIMIT 1
        `;
        const conv = rows[0];
        if (!conv) return Response.json({ error: "conversation_not_found" }, { status: 404 });

        const apiUrl = process.env.EVOLUTION_API_URL;
        const apiKey = process.env.EVOLUTION_API_KEY;
        const instance = conv.evolution_instance_name || process.env.EVOLUTION_INSTANCE_NAME;
        if (!apiUrl || !apiKey || !instance) {
          return Response.json({ error: "missing_evolution_config" }, { status: 500 });
        }
        if ((conv.channel_status ?? "").toLowerCase() !== "connected") {
          return Response.json(
            { error: "channel_not_active", status: conv.channel_status },
            { status: 409 },
          );
        }
        const number = String(conv.phone || conv.external_jid || "").replace(/\D/g, "");
        if (!number) return Response.json({ error: "missing_number" }, { status: 400 });

        const fileName = sanitizeFileName(file.name, mime);
        const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
        const base = apiUrl.replace(/\/+$/, "");
        const kind: "image" | "audio" = isImage ? "image" : "audio";

        console.log("[EVOLUTION_SEND_MEDIA]", { conversationId, instance, number, kind, size });

        let providerId: string | null = null;
        try {
          const endpoint = isImage
            ? `${base}/message/sendMedia/${encodeURIComponent(instance)}`
            : `${base}/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`;
          const payload = isImage
            ? {
                number,
                mediatype: "image",
                mimetype: mime,
                media: base64,
                fileName,
                ...(caption ? { caption } : {}),
              }
            : { number, audio: base64 };

          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: apiKey },
            body: JSON.stringify(payload),
          });
          const body = await res.text().catch(() => "");
          if (!res.ok) {
            console.error("[EVOLUTION_MEDIA_ERROR]", { status: res.status, body: body.slice(0, 500) });
            const code =
              res.status === 401 || res.status === 403
                ? "unauthorized_check_api_key"
                : "evolution_http_error";
            return Response.json(
              { error: code, status: res.status, body: body.slice(0, 500) },
              { status: 502 },
            );
          }
          try {
            providerId = JSON.parse(body)?.key?.id ?? null;
          } catch {
            /* resposta sem key.id — segue mesmo assim */
          }
        } catch (e) {
          console.error("[EVOLUTION_MEDIA_ERROR]", e);
          return Response.json(
            { error: "evolution_unreachable", message: e instanceof Error ? e.message : String(e) },
            { status: 502 },
          );
        }

        const inserted = await s<{ id: string }[]>`
          INSERT INTO public.messages
            (conversation_id, external_id, external_message_id, direction,
             message_type, message_text, from_me, status,
             media_type, media_mimetype, mime_type, media_filename, media_size,
             media_caption, media_base64,
             sent_by_user_id, sent_by_name)
          VALUES
            (${conversationId}::uuid, ${providerId}, ${providerId}, 'out',
             ${kind}, ${isImage ? caption || null : null}, true, 'sent',
             ${kind}, ${mime}, ${mime}, ${fileName}, ${size},
             ${isImage ? caption || null : null}, ${base64},
             ${attendant?.id ?? null}, ${attendant?.name ?? null})
          RETURNING id
        `;
        const messageId = inserted[0]?.id ?? null;
        if (messageId) {
          const mediaUrl = `/api/messages/${messageId}/media`;
          await s`UPDATE public.messages SET media_url = ${mediaUrl} WHERE id = ${messageId}::uuid`;
        }

        const lastMessage = isImage ? caption || "[imagem]" : "[áudio]";
        await s`
          UPDATE public.conversations
          SET last_message = ${lastMessage}, last_message_at = now(), updated_at = now()
          WHERE id = ${conversationId}::uuid
        `;

        console.log("[EVOLUTION_MEDIA_SAVED]", { conversationId, kind, messageId });
        return Response.json({ ok: true, messageId, type: kind });
      },
    },
  },
});
