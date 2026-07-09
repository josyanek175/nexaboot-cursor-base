// GET /api/webhooks/meta/diagnostic — diagnóstico público do webhook Meta (sem segredos).
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema } from "@/lib/pg.server";

const WEBHOOK_PATH = "/api/webhooks/meta/whatsapp";

export const Route = createFileRoute("/api/webhooks/meta/diagnostic")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await ensureCrmSchema();
        const url = new URL(request.url);
        const phoneNumberId = url.searchParams.get("phone_number_id")?.trim() || null;

        let channel: Record<string, unknown> | null = null;
        let recentLogs: Record<string, unknown>[] = [];

        if (phoneNumberId) {
          const s = sql();
          const rows = await s<
            {
              id: string;
              company_id: string | null;
              channel_type: string;
              status: string;
              active: boolean;
              deleted_at: Date | string | null;
              waba_id: string | null;
              business_id: string | null;
              display_phone_number: string | null;
              token_status: string | null;
              last_webhook_at: Date | string | null;
            }[]
          >`
            SELECT id, company_id, channel_type, status, active, deleted_at,
                   waba_id, business_id, display_phone_number,
                   token_status, last_webhook_at
            FROM public.whatsapp_channels
            WHERE phone_number_id = ${phoneNumberId}
            LIMIT 1
          `;
          const row = rows[0];
          if (row) {
            const wabaId = row.waba_id?.trim() || null;
            const businessId = row.business_id?.trim() || null;
            const looksLikePlaceholder = (value: string | null) =>
              !value ||
              /^(waba_id|business_id)(_real)?$/i.test(value) ||
              /_real$/i.test(value);

            channel = {
              id: row.id,
              companyId: row.company_id,
              channelType: row.channel_type,
              status: row.status,
              active: row.active,
              deletedAt: row.deleted_at ? String(row.deleted_at) : null,
              wabaId,
              businessId,
              displayPhoneNumber: row.display_phone_number,
              wabaIdLooksInvalid: looksLikePlaceholder(wabaId),
              businessIdLooksInvalid: looksLikePlaceholder(businessId),
              tokenStatus: row.token_status,
              lastWebhookAt: row.last_webhook_at ? String(row.last_webhook_at) : null,
              eligibleForWebhook:
                String(row.channel_type).toLowerCase() === "meta" &&
                String(row.status).toUpperCase() === "ACTIVE" &&
                row.active === true &&
                row.deleted_at == null &&
                !!row.company_id,
            };
          }

          recentLogs = await s<
            {
              id: string;
              processing_status: string;
              signature_valid: boolean;
              event_type: string | null;
              error: string | null;
              created_at: Date | string;
            }[]
          >`
            SELECT id, processing_status, signature_valid, event_type, error, created_at
            FROM public.meta_webhook_event_logs
            WHERE phone_number_id = ${phoneNumberId}
            ORDER BY created_at DESC
            LIMIT 5
          `.then((rows) =>
            rows.map((r) => ({
              id: r.id,
              processingStatus: r.processing_status,
              signatureValid: r.signature_valid,
              eventType: r.event_type,
              error: r.error,
              createdAt: String(r.created_at),
            })),
          );
        }

        return Response.json({
          ok: true,
          service: "nexaboot-meta-webhook",
          webhookPath: WEBHOOK_PATH,
          verifyGetExample: `${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=<META_APP_VERIFY_TOKEN>&hub.challenge=123456`,
          postPath: WEBHOOK_PATH,
          env: {
            hasMetaVerifyToken: !!process.env.META_APP_VERIFY_TOKEN?.trim(),
            hasMetaAppSecret: !!process.env.META_APP_SECRET?.trim(),
            hasTokenEncryptionKey: !!process.env.META_TOKEN_ENCRYPTION_KEY?.trim(),
            graphApiVersion: process.env.META_GRAPH_API_VERSION?.trim() || "v20.0",
          },
          notes: [
            "Use o domínio WEB de produção (nexaboot-web), nunca nexaboot-api.",
            "META_APP_SECRET deve ser o App Secret do app Meta (Settings > Basic).",
            "META_TOKEN_ENCRYPTION_KEY cifra tokens no banco; não é Bearer da Graph API.",
            "POST sem x-hub-signature-256 é rejeitado (missing_signature).",
          ],
          channel,
          recentWebhookLogs: recentLogs,
        });
      },
    },
  },
});
