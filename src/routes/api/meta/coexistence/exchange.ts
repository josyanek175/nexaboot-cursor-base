// POST /api/meta/coexistence/exchange
// Troca o authorization code UMA vez → onboarding temporário cifrado.
// Resposta segura: onboarding_id + IDs públicos. Nunca devolve token/code.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import { ensureMetaTokenEncryptionConfigured } from "@/lib/meta-channels.server";
import {
  assertMetaCoexistenceAccessWithScope,
  extractRequestedCompanyId,
} from "@/lib/meta-coexistence-policy.server";
import {
  exchangeAuthorizationCode,
  resolveWhatsAppAssetsFromToken,
} from "@/lib/meta-coexistence-graph.server";
import {
  cleanupExpiredCoexistenceOnboardings,
  coexistenceOnboardingTablesReady,
  consumeCoexistenceCsrfState,
  createCoexistenceOnboarding,
  toSafeOnboardingDto,
} from "@/lib/meta-coexistence-onboarding.server";

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
});

export const Route = createFileRoute("/api/meta/coexistence/exchange")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const uid = await getSessionUserId();
        if (!uid) {
          return Response.json({ error: "unauthenticated" }, { status: 401 });
        }
        const info = await getCurrentUserCompanyInfo(uid);
        const json = await request.json().catch(() => null);
        const gate = assertMetaCoexistenceAccessWithScope({
          role: info.role,
          sessionCompanyId: companyId,
          requestedCompanyId: extractRequestedCompanyId(json),
        });
        if (gate) return gate;

        if (!(await coexistenceOnboardingTablesReady())) {
          return Response.json(
            {
              error: "migration_required",
              message:
                "Aplique docs/migrations/20260801_meta_coexistence_onboarding.sql em DEV.",
            },
            { status: 503 },
          );
        }

        const encryptionError = ensureMetaTokenEncryptionConfigured();
        if (encryptionError) return encryptionError;

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

        // Code só é usado aqui — nunca logado, nunca devolvido.
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

        const assets = await resolveWhatsAppAssetsFromToken(
          exchanged.accessToken,
          parsed.data.session_info ?? null,
        );
        if ("error" in assets) {
          // Falha Graph: não persiste onboarding incompleto.
          console.error("[META_COEXISTENCE_ASSETS_FAIL]", { reason: assets.error });
          return Response.json(
            {
              error: assets.error,
              message:
                "Não foi possível resolver WABA/phone_number_id. Envie session_info do Embedded Signup ou verifique o token.",
            },
            { status: 400 },
          );
        }

        const tokenExpiresAt =
          exchanged.expiresIn != null
            ? new Date(Date.now() + exchanged.expiresIn * 1000)
            : null;

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

          return Response.json({
            ok: true,
            onboarding: toSafeOnboardingDto(row),
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "create_failed";
          console.error("[META_COEXISTENCE_ONBOARDING_PERSIST_FAIL]", {
            error: msg === "missing_encryption_key" ? msg : "persist_failed",
          });
          return Response.json(
            {
              error: msg === "missing_encryption_key" ? "missing_encryption_key" : "onboarding_persist_failed",
            },
            { status: msg === "missing_encryption_key" ? 503 : 500 },
          );
        }
      },
    },
  },
});
