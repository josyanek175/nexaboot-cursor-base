/**
 * Permissões de Campanhas para ATENDENTE + regressão dos demais perfis.
 * Uso: npx tsx scripts/test-campaign-atendente-permissions.mjs
 *
 * Não exige DATABASE_URL. Não altera banco.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canViewCampaigns,
  canManageCampaigns,
  canDeleteCampaign,
  canPauseResumeCampaign,
  canAccessCampaignsModule,
  canViewUsersScreen,
  canManageChannels,
  canManageIntegrations,
} from "../src/lib/permissions.ts";

let failed = 0;

function check(label, condition) {
  try {
    assert.ok(condition, label);
    console.log(`OK   ${label}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${label}`, e instanceof Error ? e.message : e);
  }
}

const uidA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const uidB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const company = "11111111-1111-1111-1111-111111111111";

function actor(role, id = uidA) {
  return { id, role, tenantId: company };
}

// ── ATENDENTE: módulo Campanhas ─────────────────────────────────────────────
check("ATENDENTE canViewCampaigns", canViewCampaigns(actor("ATENDENTE")));
check("ATENDENTE canManageCampaigns", canManageCampaigns(actor("ATENDENTE")));
check("ATENDENTE canAccessCampaignsModule (empresa ok)", canAccessCampaignsModule(actor("ATENDENTE"), true));
check(
  "ATENDENTE sem empresa não acessa módulo",
  canAccessCampaignsModule(actor("ATENDENTE"), false) === false,
);
check("ATENDENTE não pode excluir campanha", canDeleteCampaign(actor("ATENDENTE")) === false);

check(
  "ATENDENTE pausa/retoma campanha própria",
  canPauseResumeCampaign(actor("ATENDENTE", uidA), uidA),
);
check(
  "ATENDENTE não pausa campanha de outro",
  canPauseResumeCampaign(actor("ATENDENTE", uidA), uidB) === false,
);
check(
  "ATENDENTE não pausa sem created_by",
  canPauseResumeCampaign(actor("ATENDENTE", uidA), null) === false,
);

// ── ATENDENTE: módulos administrativos bloqueados ───────────────────────────
check("ATENDENTE não vê Usuários", canViewUsersScreen(actor("ATENDENTE")) === false);
check("ATENDENTE não gerencia Canais", canManageChannels(actor("ATENDENTE")) === false);
check("ATENDENTE não gerencia Integrações", canManageIntegrations(actor("ATENDENTE")) === false);

// ── ATENDENTE_GERAL permanece excluído de Campanhas ─────────────────────────
check("ATENDENTE_GERAL não vê Campanhas", canViewCampaigns(actor("ATENDENTE_GERAL")) === false);
check("ATENDENTE_GERAL não gerencia Campanhas", canManageCampaigns(actor("ATENDENTE_GERAL")) === false);

// ── Demais perfis (regressão) ───────────────────────────────────────────────
for (const role of ["SUPERVISOR", "GERENTE", "ADMIN_EMPRESA", "ADMIN_GERAL", "TI"]) {
  check(`${role} canViewCampaigns`, canViewCampaigns(actor(role)));
  check(`${role} canManageCampaigns`, canManageCampaigns(actor(role)));
  check(
    `${role} pausa qualquer campanha da empresa`,
    canPauseResumeCampaign(actor(role, uidA), uidB),
  );
}

check("SUPERVISOR não exclui", canDeleteCampaign(actor("SUPERVISOR")) === false);
check("GERENTE exclui", canDeleteCampaign(actor("GERENTE")));
check("ADMIN_EMPRESA exclui", canDeleteCampaign(actor("ADMIN_EMPRESA")));

// ── Fonte: backend aplica ownership + company_id ────────────────────────────
const root = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const perms = read("src/lib/permissions.ts");
check(
  "permissions: ATENDENTE em canManageCampaigns",
  /canManageCampaigns[\s\S]*ATENDENTE/.test(perms),
);
check(
  "permissions: canPauseResumeCampaign exige criador para ATENDENTE",
  /canPauseResumeCampaign[\s\S]*actor\.role !== "ATENDENTE"[\s\S]*creator === actor\.id/.test(perms),
);

const campaignServer = read("src/lib/campaign.server.ts");
check(
  "backend pause usa canPauseResumeCampaign",
  /pauseCampaignManually[\s\S]*canPauseResumeCampaign/.test(campaignServer),
);
check(
  "backend resume usa canPauseResumeCampaign",
  /resumeCampaignManually[\s\S]*canPauseResumeCampaign/.test(campaignServer),
);
check(
  "validateCampaignChannel filtra company_id",
  /validateCampaignChannel[\s\S]*company_id = \$\{companyId\}/.test(campaignServer),
);
check(
  "getCampaignById filtra company_id",
  /getCampaignById[\s\S]*c\.company_id = \$\{companyId\}/.test(campaignServer),
);
check(
  "auditoria insertCampaignEvent com created_by_user_id",
  /insertCampaignEvent[\s\S]*created_by_user_id/.test(campaignServer),
);

const pauseApi = read("src/routes/api/campaigns/$id/pause.ts");
const resumeApi = read("src/routes/api/campaigns/$id/resume.ts");
check("API pause passa actor", /pauseCampaignManually\([\s\S]*ctx\.actor/.test(pauseApi));
check("API resume passa actor", /resumeCampaignManually\([\s\S]*ctx\.actor/.test(resumeApi));
check("API pause mapeia forbidden_not_owner", pauseApi.includes("forbidden_not_owner"));
check("API resume mapeia forbidden_not_owner", resumeApi.includes("forbidden_not_owner"));

const detailUi = read("src/routes/_app.campanhas.$id.tsx");
check("UI detalhe usa canPauseResumeCampaign", detailUi.includes("canPauseResumeCampaign"));
check("UI detalhe envia created_by_user_id no tipo", detailUi.includes("created_by_user_id"));

const shell = read("src/components/app-shell.tsx");
check("menu Campanhas usa canAccessCampaignsModule", shell.includes("canAccessCampaignsModule"));

if (failed > 0) {
  console.error(`\n${failed} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os checks de permissão ATENDENTE/Campanhas passaram.");
