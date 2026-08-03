// GET /api/meta/channels/:id/connection-status
// Status de conexão Meta (coexistence/cloud_api) sem expor token/secrets.
import { createFileRoute } from "@tanstack/react-router";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import {
  META_CHANNEL_UUID_RE,
  getMetaChannelRowForCompany,
  toPublicTokenStatus,
} from "@/lib/meta-channels.server";
import { resolveMetaConnectionMode } from "@/lib/meta-connection-mode";
import { whatsappChannelsHasMetaConnectionModeColumn } from "@/lib/meta-coexistence.server";
import {
  assertMetaCoexistenceAccessWithScope,
  extractRequestedCompanyId,
} from "@/lib/meta-coexistence-policy.server";
import { metaWhatsAppProvider } from "@/lib/whatsapp/providers/meta-whatsapp-provider.server";
import { sql } from "@/lib/pg.server";

export const Route = createFileRoute("/api/meta/channels/$id/connection-status")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const uid = getSessionUserId();
        if (!uid) {
          return Response.json({ error: "unauthenticated" }, { status: 401 });
        }
        const info = await getCurrentUserCompanyInfo(uid);
        const url = new URL(request.url);
        const gate = assertMetaCoexistenceAccessWithScope({
          role: info.role,
          sessionCompanyId: companyId,
          requestedCompanyId: extractRequestedCompanyId({
            company_id: url.searchParams.get("company_id"),
          }),
        });
        if (gate) return gate;

        if (!META_CHANNEL_UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const row = await getMetaChannelRowForCompany(params.id, companyId);
        if (!row) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        const hasMode = await whatsappChannelsHasMetaConnectionModeColumn();
        let connectionMode = resolveMetaConnectionMode(
          (row as { meta_connection_mode?: string | null }).meta_connection_mode,
        );
        let coexistenceStatus: string | null = null;
        let connectedAt: string | null = null;
        let webhookSubscriptionStatus: string | null = null;
        let webhookSubscribedAt: string | null = null;
        let onboardingCompletedAt: string | null = null;

        if (hasMode) {
          const s = sql();
          try {
            const extra = await s<
              {
                meta_connection_mode: string | null;
                coexistence_status: string | null;
                connected_at: Date | string | null;
                webhook_subscription_status: string | null;
                webhook_subscribed_at: Date | string | null;
                onboarding_completed_at: Date | string | null;
              }[]
            >`
              SELECT
                meta_connection_mode,
                coexistence_status,
                connected_at,
                webhook_subscription_status,
                webhook_subscribed_at,
                onboarding_completed_at
              FROM public.whatsapp_channels
              WHERE id = ${params.id}::uuid
                AND company_id = ${companyId}::uuid
              LIMIT 1
            `;
            if (extra[0]) {
              connectionMode = resolveMetaConnectionMode(extra[0].meta_connection_mode);
              coexistenceStatus = extra[0].coexistence_status;
              connectedAt = extra[0].connected_at != null ? String(extra[0].connected_at) : null;
              webhookSubscriptionStatus = extra[0].webhook_subscription_status;
              webhookSubscribedAt =
                extra[0].webhook_subscribed_at != null
                  ? String(extra[0].webhook_subscribed_at)
                  : null;
              onboardingCompletedAt =
                extra[0].onboarding_completed_at != null
                  ? String(extra[0].onboarding_completed_at)
                  : null;
            }
          } catch {
            const extra = await s<
              {
                meta_connection_mode: string | null;
                coexistence_status: string | null;
                webhook_subscription_status: string | null;
                onboarding_completed_at: Date | string | null;
              }[]
            >`
              SELECT
                meta_connection_mode,
                coexistence_status,
                webhook_subscription_status,
                onboarding_completed_at
              FROM public.whatsapp_channels
              WHERE id = ${params.id}::uuid
                AND company_id = ${companyId}::uuid
              LIMIT 1
            `;
            if (extra[0]) {
              connectionMode = resolveMetaConnectionMode(extra[0].meta_connection_mode);
              coexistenceStatus = extra[0].coexistence_status;
              webhookSubscriptionStatus = extra[0].webhook_subscription_status;
              onboardingCompletedAt =
                extra[0].onboarding_completed_at != null
                  ? String(extra[0].onboarding_completed_at)
                  : null;
            }
          }
        }

        const hasToken = await metaWhatsAppProvider.hasAccessToken(row.id, row.company_id);

        return Response.json({
          id: row.id,
          channel_type: "meta",
          connection_mode: connectionMode,
          meta_connection_mode: connectionMode,
          status: row.status,
          coexistence_status: coexistenceStatus,
          token_status: toPublicTokenStatus(hasToken),
          waba_id: row.waba_id,
          phone_number_id: row.phone_number_id,
          display_phone_number: row.display_phone_number,
          last_webhook_at: row.last_webhook_at != null ? String(row.last_webhook_at) : null,
          connected_at: connectedAt ?? onboardingCompletedAt,
          webhook_subscription_status: webhookSubscriptionStatus,
          webhook_subscribed_at: webhookSubscribedAt,
          onboarding_completed_at: onboardingCompletedAt,
          last_error_code: row.last_error_code,
          last_error_message: row.last_error_message,
        });
      },
    },
  },
});
