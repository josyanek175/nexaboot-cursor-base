// POST /api/meta/embedded-signup/complete
// Code → token (1x) → WABA/phone → subscribe webhooks → canal coexistence (TX).
// Nunca devolve token/code.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import {
  buildMetaChannelPublic,
  ensureMetaTokenEncryptionConfigured,
  getMetaChannelRowForCompany,
} from "@/lib/meta-channels.server";
import {
  assertMetaCoexistenceAccess,
  getMetaCoexistencePublicConfig,
} from "@/lib/meta-coexistence-policy.server";
import {
  exchangeAuthorizationCode,
  resolveWhatsAppAssetsFromToken,
  subscribeAppToWaba,
  verifyAppSubscribedToWaba,
} from "@/lib/meta-coexistence-graph.server";
import {
  cleanupExpiredCoexistenceOnboardings,
  coexistenceOnboardingTablesReady,
  completeCoexistenceConnectTransactional,
  consumeCoexistenceCsrfState,
  createCoexistenceOnboarding,
} from "@/lib/meta-coexistence-onboarding.server";
import { whatsappChannelsHasMetaConnectionModeColumn } from "@/lib/meta-coexistence.server";

const SessionInfoSchema = z
  .object({
    waba_id: z.string().trim().min(1).max(120).optional().nullable(),
    phone_number_id: z.string().trim().min(1).max(120).optional().nullable(),
    business_id: z.string().trim().min(1).max(120).optional().nullable(),
    display_phone_number: z.string().trim().min(1).max(40).optional().nullable(),
  })
  .optional()
  .nullable();

const Body = z.object({
  code: z.string().trim().min(1).max(4096),
  state: z.string().trim().min(16).max(256),
  session_info: SessionInfoSchema,
  name: z.string().trim().min(1).max(120).optional().nullable(),
});

export const Route = createFileRoute("/api/meta/embedded-signup/complete")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const uid = getSessionUserId();
        if (!uid) {
          return Response.json({ error: "unauthenticated" }, { status: 401 });
        }
        const info = await getCurrentUserCompanyInfo(uid);
        const gate = assertMetaCoexistenceAccess({
          role: info.role,
          companyId,
        });
        if (gate) return gate;

        if (!(await coexistenceOnboardingTablesReady())) {
          return Response.json({ error: "migration_required" }, { status: 503 });
        }
        if (!(await whatsappChannelsHasMetaConnectionModeColumn())) {
          return Response.json({ error: "migration_required" }, { status: 503 });
        }

        const encryptionError = ensureMetaTokenEncryptionConfigured();
        if (encryptionError) return encryptionError;

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input", detail: parsed.error.flatten() }, { status: 400 });
        }

        await cleanupExpiredCoexistenceOnboardings().catch(() => undefined);

        const csrfOk = await consumeCoexistenceCsrfState(parsed.data.state, companyId, uid);
        if (!csrfOk) {
          return Response.json(
            { error: "invalid_csrf_state", message: "State CSRF inválido, expirado ou já usado." },
            { status: 403 },
          );
        }

        // 1) Troca code UMA vez (nunca logado).
        const exchanged = await exchangeAuthorizationCode(parsed.data.code);
        if (!exchanged.ok) {
          if (exchanged.reason === "not_configured") {
            return Response.json({ error: "meta_app_not_configured" }, { status: 503 });
          }
          if (exchanged.reason === "rejected") {
            return Response.json({ error: "exchange_rejected" }, { status: 400 });
          }
          return Response.json({ error: "exchange_failed" }, { status: 502 });
        }

        // 2) Consulta WABA / phone (Graph — fora da TX).
        const assets = await resolveWhatsAppAssetsFromToken(
          exchanged.accessToken,
          parsed.data.session_info ?? null,
        );
        if ("error" in assets) {
          console.error("[META_EMBEDDED_SIGNUP_ASSETS_FAIL]", { reason: assets.error });
          return Response.json(
            {
              error: assets.error,
              message:
                "Não foi possível resolver WABA/phone_number_id. Confira session_info do Embedded Signup.",
            },
            { status: 400 },
          );
        }

        // 3) Assina app na WABA + valida inscrição (Graph — fora da TX).
        const subscribed = await subscribeAppToWaba(assets.wabaId, exchanged.accessToken);
        let webhookSubscriptionStatus = "failed";
        let webhookSubscribedAt: Date | null = null;
        if (subscribed.ok) {
          const verified = await verifyAppSubscribedToWaba(assets.wabaId, exchanged.accessToken);
          webhookSubscriptionStatus = verified ? "subscribed" : "subscribe_unconfirmed";
          webhookSubscribedAt = verified ? new Date() : null;
        }

        const tokenExpiresAt =
          exchanged.expiresIn != null
            ? new Date(Date.now() + exchanged.expiresIn * 1000)
            : null;

        // 4) Onboarding temp cifrado → 5) TX canal + vault + consume.
        let onboardingId: string;
        try {
          const row = await createCoexistenceOnboarding({
            companyId,
            userId: uid,
            accessToken: exchanged.accessToken,
            tokenExpiresAt,
            wabaId: assets.wabaId,
            phoneNumberId: assets.phoneNumberId,
            businessId: assets.businessId,
            displayPhoneNumber: assets.displayPhoneNumber,
          });
          onboardingId = row.id;
        } catch (e) {
          const msg = e instanceof Error ? e.message : "persist_failed";
          console.error("[META_EMBEDDED_SIGNUP_ONBOARDING_FAIL]", {
            error: msg === "missing_encryption_key" ? msg : "persist_failed",
          });
          return Response.json(
            {
              error: msg === "missing_encryption_key" ? "missing_encryption_key" : "onboarding_persist_failed",
            },
            { status: msg === "missing_encryption_key" ? 503 : 500 },
          );
        }

        const pub = getMetaCoexistencePublicConfig();
        const txResult = await completeCoexistenceConnectTransactional({
          onboardingId,
          companyId,
          userId: uid,
          role: info.role,
          channelName:
            parsed.data.name?.trim() ||
            assets.verifiedName ||
            assets.displayPhoneNumber ||
            null,
          embeddedSignupConfigId: pub.configId,
          webhookSubscriptionStatus,
          webhookSubscribedAt,
          verifiedName: assets.verifiedName,
        });

        if (!txResult.ok) {
          // Onboarding permanece utilizável até TTL se a TX falhou (não consumido).
          return Response.json(
            {
              error: txResult.error,
              onboarding_id: onboardingId,
              retryable: !["company_mismatch", "user_mismatch", "phone_number_id_belongs_to_another_company"].includes(
                txResult.error,
              ),
            },
            { status: txResult.error === "phone_number_id_belongs_to_another_company" ? 409 : 500 },
          );
        }

        const channelRow = await getMetaChannelRowForCompany(txResult.channelId, companyId);
        if (!channelRow) {
          return Response.json({ error: "create_failed" }, { status: 500 });
        }

        const channel = await buildMetaChannelPublic(channelRow);
        return Response.json(
          {
            ok: true,
            connection_mode: "coexistence",
            webhook_subscription_status: webhookSubscriptionStatus,
            channel: {
              ...channel,
              // Alias seguro pedido pelo contrato de API
              connection_mode: channel.meta_connection_mode,
            },
            assets: {
              waba_id: assets.wabaId,
              phone_number_id: assets.phoneNumberId,
              display_phone_number: assets.displayPhoneNumber,
              verified_name: assets.verifiedName,
              // business_id omitido se preferir privacidade — incluímos só se já público no canal
              business_id: assets.businessId,
            },
            idempotent: txResult.idempotent,
          },
          { status: txResult.idempotent ? 200 : 201 },
        );
      },
    },
  },
});
