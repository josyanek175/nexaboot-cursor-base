// GET /api/meta/coexistence/config
// Config pública + CSRF state. 404 se META_COEXISTENCE_ENABLED off.
import { createFileRoute } from "@tanstack/react-router";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import {
  canManageMetaCoexistence,
  getMetaCoexistencePublicConfig,
  isMetaCoexistenceEnabled,
  metaCoexistenceDisabledResponse,
  metaCoexistenceForbiddenResponse,
} from "@/lib/meta-coexistence-policy.server";
import { whatsappChannelsHasMetaConnectionModeColumn } from "@/lib/meta-coexistence.server";
import {
  cleanupExpiredCoexistenceOnboardings,
  coexistenceOnboardingTablesReady,
  createCoexistenceCsrfState,
} from "@/lib/meta-coexistence-onboarding.server";

export const Route = createFileRoute("/api/meta/coexistence/config")({
  server: {
    handlers: {
      GET: async () => {
        if (!isMetaCoexistenceEnabled()) {
          return metaCoexistenceDisabledResponse();
        }

        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const uid = getSessionUserId();
        if (!uid) {
          return Response.json({ error: "unauthenticated" }, { status: 401 });
        }
        const info = await getCurrentUserCompanyInfo(uid);
        if (!canManageMetaCoexistence(info.role)) {
          return metaCoexistenceForbiddenResponse();
        }

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

        await cleanupExpiredCoexistenceOnboardings().catch(() => undefined);

        const pub = getMetaCoexistencePublicConfig();
        const migrationApplied = await whatsappChannelsHasMetaConnectionModeColumn();
        const csrfState = await createCoexistenceCsrfState(companyId, uid);

        return Response.json({
          enabled: true,
          meta_connection_mode: "coexistence",
          migrationApplied,
          onboardingTablesReady: true,
          appId: pub.appId,
          configId: pub.configId,
          graphVersion: pub.graphVersion,
          redirectUri: pub.redirectUri,
          csrf_state: csrfState,
          ready: Boolean(pub.appId && pub.configId && migrationApplied),
        });
      },
    },
  },
});
