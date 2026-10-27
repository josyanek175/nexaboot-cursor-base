import { spawnSync } from "node:child_process";
const cases = [
  "test-operations-migration.mjs",
  "test-public-admin-guards.mjs",
  "test-demo-seed-disabled.mjs",
  "test-platform-diagnostics.mjs",
  "test-company-listing.mjs",
  "test-ti-company-context.mjs",
  "test-user-management-policy.mjs",
  "test-company-operations.mjs",
  "test-flow-lifecycle-isolated.mjs",
  "test-meta-flow-buttons.mjs",
  "test-channel-permissions.mjs",
  "test-dashboard-channel-permissions.mjs",
  "test-internal-groups.mjs",
  "test-password-recovery.mjs",
  "test-session-expiry.mjs",
  "test-session-revocation.mjs",
  "test-company-isolation.mjs",
  "test-portal-integration.mjs",
  "test-portal-operations.mjs",
  "test-automation-flow.mjs",
  "test-automation-flow-definition.mjs",
  "test-automation-flow-builder.mjs",
  "test-meta-inbound-extract.mjs",
  "test-campaign-worker-direct.mjs",
];
let failed = 0;
for (const file of cases) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/" + file], {
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://disabled:disabled@127.0.0.1:1/disabled_test",
      CAMPAIGN_WORKER_ENABLED: "false",
    },
  });
  if (result.status !== 0) {
    failed++;
    console.error(
      "FAIL " +
        file +
        "\n" +
        result.stdout +
        "\n" +
        result.stderr +
        (result.error ? "\n" + result.error.message : ""),
    );
  } else console.log("PASS " + file);
}
console.log(
  `${cases.length - failed}/${cases.length} suites passed. Isolated database and fake external transports only.`,
);
if (failed) process.exit(1);
