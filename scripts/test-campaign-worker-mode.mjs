/**
 * Testes do modo CAMPAIGN_WORKER_MODE e gates HTTP.
 * Uso: npx tsx scripts/test-campaign-worker-mode.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCampaignWorkerMode,
  readCampaignWorkerConcurrency,
  campaignWorkerModeHttpResponse,
} from "../src/lib/campaign-worker-mode.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let failed = 0;
function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

assert("default mode http when absent", parseCampaignWorkerMode({}) === "http");
assert(
  "default mode http when empty",
  parseCampaignWorkerMode({ CAMPAIGN_WORKER_MODE: "" }) === "http",
);
assert(
  "default mode http when garbage",
  parseCampaignWorkerMode({ CAMPAIGN_WORKER_MODE: "foo" }) === "http",
);
assert(
  "mode direct",
  parseCampaignWorkerMode({ CAMPAIGN_WORKER_MODE: "direct" }) === "direct",
);
assert(
  "mode disabled",
  parseCampaignWorkerMode({ CAMPAIGN_WORKER_MODE: "disabled" }) === "disabled",
);
assert(
  "mode case insensitive",
  parseCampaignWorkerMode({ CAMPAIGN_WORKER_MODE: "DIRECT" }) === "direct",
);

assert("concurrency default 1", readCampaignWorkerConcurrency({}) === 1);
assert(
  "concurrency reads 1",
  readCampaignWorkerConcurrency({ CAMPAIGN_WORKER_CONCURRENCY: "1" }) === 1,
);

{
  const res = campaignWorkerModeHttpResponse("direct");
  assert("direct status 503", res.status === 503);
  const body = await res.json();
  assert("direct code", body.code === "worker_mode_direct");
  assert("direct ok false", body.ok === false);
}

{
  const res = campaignWorkerModeHttpResponse("disabled");
  assert("disabled status 503", res.status === 503);
  const body = await res.json();
  assert("disabled code", body.code === "worker_disabled");
}

const tickSrc = readFileSync(join(root, "src/routes/api/campaigns/worker/tick.ts"), "utf8");
assert("tick route parses mode", tickSrc.includes("parseCampaignWorkerMode"));
assert("tick route gates non-http", tickSrc.includes('mode !== "http"'));
assert("tick route uses campaignWorkerModeHttpResponse", tickSrc.includes("campaignWorkerModeHttpResponse"));
assert(
  "tick route injects getSql in http",
  tickSrc.includes("processCampaignWorkerTick({ sql: getSql() })"),
);

const startSrc = readFileSync(join(root, "src/routes/api/campaigns/$id/start.ts"), "utf8");
const resumeSrc = readFileSync(join(root, "src/routes/api/campaigns/$id/resume.ts"), "utf8");
assert("start only ticks in http", /mode === "http"[\s\S]*processCampaignWorkerTick/.test(startSrc));
assert("resume only ticks in http", /mode === "http"[\s\S]*processCampaignWorkerTick/.test(resumeSrc));
assert(
  "start does not tick unconditionally",
  !/await processCampaignWorkerTick\(\)/.test(startSrc),
);

const workerSrc = readFileSync(join(root, "src/lib/campaign-worker.server.ts"), "utf8");
assert(
  "campaign-worker.server does not import pg.server",
  !workerSrc.includes('from "@/lib/pg.server"'),
);
assert(
  "processCampaignWorkerTick requires options.sql",
  workerSrc.includes("options: ProcessCampaignWorkerTickOptions"),
);

const pgWorkerSrc = readFileSync(join(root, "src/lib/pg-worker.server.ts"), "utf8");
assert("pg-worker has closeWorkerSql", pgWorkerSrc.includes("export async function closeWorkerSql"));
assert(
  "pg-worker does not import pg.server",
  !pgWorkerSrc.includes('from "@/lib/pg.server"'),
);
assert("pg-worker pool max default 2", pgWorkerSrc.includes("return 2"));
assert("pg-worker prepare false", pgWorkerSrc.includes("prepare: false"));
assert("pg-worker max_lifetime 1800", pgWorkerSrc.includes("60 * 30"));
assert(
  "pg-worker applies statement_timeout via connection",
  pgWorkerSrc.includes("statement_timeout: String(statementTimeoutMs)"),
);
assert(
  "pg-worker reads CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS",
  pgWorkerSrc.includes("CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS"),
);

const { readCampaignWorkerStatementTimeoutMs } = await import(
  "../src/lib/pg-worker.server.ts"
);
assert(
  "statement timeout default 15000",
  readCampaignWorkerStatementTimeoutMs({}) === 15_000,
);
assert(
  "statement timeout absent uses default",
  readCampaignWorkerStatementTimeoutMs({ CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS: "" }) === 15_000,
);
assert(
  "statement timeout custom",
  readCampaignWorkerStatementTimeoutMs({ CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS: "25000" }) === 25_000,
);
assert(
  "statement timeout invalid uses default",
  readCampaignWorkerStatementTimeoutMs({ CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS: "abc" }) === 15_000,
);
assert(
  "statement timeout zero uses default",
  readCampaignWorkerStatementTimeoutMs({ CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS: "0" }) === 15_000,
);
assert(
  "statement timeout negative uses default",
  readCampaignWorkerStatementTimeoutMs({ CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS: "-5" }) === 15_000,
);

const pgWebSrc = readFileSync(join(root, "src/lib/pg.server.ts"), "utf8");
assert(
  "pg.server does not read CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS",
  !pgWebSrc.includes("CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS"),
);

const docsSrc = readFileSync(join(root, "docs/campaign-worker-direct.md"), "utf8");
assert(
  "docs list CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS=15000",
  docsSrc.includes("CAMPAIGN_WORKER_PG_STATEMENT_TIMEOUT_MS=15000"),
);

// Sem commits de relatórios nesta branch
const { execSync } = await import("node:child_process");
const log = execSync("git log --oneline origin/dev..HEAD", { cwd: root, encoding: "utf8" });
assert("no conversation-reports commit", !/conversation.?report/i.test(log));
assert("no campaign-export-csv commit", !/export.?csv/i.test(log));

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll campaign-worker-mode tests passed");
