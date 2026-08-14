// POST /api/meta/coexistence/connect
// Consome onboarding_id dentro de uma transação PG (sem code / sem token do frontend).
// Sem Graph API neste endpoint.
import { createFileRoute } from "@tanstack/react-router";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import {
  buildMetaChannelPublic,
  ensureMetaTokenEncryptionConfigured,
  getMetaChannelRowForCompany,
} from "@/lib/meta-channels.server";
import {
  CoexistenceConnectBodySchema,
  findForbiddenConnectField,
} from "@/lib/meta-coexistence-connect-body";
import {
  assertMetaCoexistenceAccessWithScope,
  extractRequestedCompanyId,
  getMetaCoexistencePublicConfig,
} from "@/lib/meta-coexistence-policy.server";
import { whatsappChannelsHasMetaConnectionModeColumn } from "@/lib/meta-coexistence.server";
import {
  cleanupExpiredCoexistenceOnboardings,
  coexistenceOnboardingTablesReady,
  completeCoexistenceConnectTransactional,
} from "@/lib/meta-coexistence-onboarding.server";

const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  expired: 410,
  consumed: 409,
  company_mismatch: 403,
  user_mismatch: 403,
  missing_token: 410,
  decrypt_failed: 500,
  onboarding_incomplete: 400,
  phone_number_id_belongs_to_another_company: 409,
  phone_number_id_already_exists: 409,
  missing_encryption_key: 503,
  create_failed: 500,
  migration_required: 503,
};

function connectErrorResponse(code: string): Response {
  const status = ERROR_STATUS[code] ?? 500;
  const barePhone =
    code === "phone_number_id_belongs_to_another_company" ||
    code === "phone_number_id_already_exists" ||
    code === "missing_encryption_key" ||
    code === "create_failed";
  return Response.json(
    { error: barePhone ? code : `onboarding_${code}` },
    { status },
  );
}

export const Route = createFileRoute("/api/meta/coexistence/connect")({
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
          return Response.json({ error: "migration_required" }, { status: 503 });
        }

        if (!(await whatsappChannelsHasMetaConnectionModeColumn())) {
          return Response.json(
            {
              error: "migration_required",
              message:
                "Aplique a migration docs/migrations/20260801_meta_connection_mode.sql em DEV.",
            },
            { status: 503 },
          );
        }

        const encryptionError = ensureMetaTokenEncryptionConfigured();
        if (encryptionError) return encryptionError;

        const forbidden = findForbiddenConnectField(json);
        if (forbidden) {
          return Response.json({ error: "forbidden_field", field: forbidden }, { status: 400 });
        }

        const parsed = CoexistenceConnectBodySchema.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input", detail: parsed.error.flatten() }, { status: 400 });
        }

        await cleanupExpiredCoexistenceOnboardings().catch(() => undefined);

        const pub = getMetaCoexistencePublicConfig();
        const txResult = await completeCoexistenceConnectTransactional({
          onboardingId: parsed.data.onboarding_id,
          companyId,
          userId: uid,
          role: info.role,
          channelName: parsed.data.name?.trim() || null,
          embeddedSignupConfigId: pub.configId,
        });

        if (!txResult.ok) {
          return connectErrorResponse(txResult.error);
        }

        const row = await getMetaChannelRowForCompany(txResult.channelId, companyId);
        if (!row) {
          return Response.json({ error: "create_failed" }, { status: 500 });
        }

        const channel = await buildMetaChannelPublic(row);
        return Response.json(
          { channel, idempotent: txResult.idempotent },
          { status: txResult.idempotent ? 200 : 201 },
        );
      },
    },
  },
});
