/**
 * Testes de modelos de campanha (Evolution + conversão Meta).
 * Uso: npx tsx scripts/test-campaign-templates.mjs
 */
import {
  parseTemplateMessageBody,
  serializeTemplateMessageBody,
  stripTemplateMetadata,
} from "../src/lib/campaign-template-metadata.ts";
import {
  convertMetaPlaceholdersToEvolution,
  convertMetaTemplateToEvolutionDraft,
  formatNumberedResponseBlock,
} from "../src/lib/campaign-template-meta-convert.ts";
import {
  previewEvolutionTemplate,
  renderEvolutionTemplateBody,
} from "../src/lib/campaign-template-variables.ts";
import { classifyCampaignResponse } from "../src/lib/campaign-response.server.ts";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

// substituição {nome}
{
  const out = renderEvolutionTemplateBody("Oi, {nome}!", { nome: "Maria" });
  assert("render nome", out === "Oi, Maria!");
}

// preview fictício
{
  const preview = previewEvolutionTemplate("Olá {nome}, seu {produto}");
  assert("preview has sample nome", preview.includes("Maria Silva"));
  assert("preview has sample produto", preview.includes("Refil"));
}

// conversão Meta {{1}} → {nome}
{
  const body = convertMetaPlaceholdersToEvolution("Oi, {{1}}! 😊", { "1": "name" });
  assert("meta placeholder to nome", body === "Oi, {nome}! 😊");
}

// conversão completa com botões numerados
{
  const draft = convertMetaTemplateToEvolutionDraft({
    templateName: "abordagem_inicial",
    languageCode: "pt_BR",
    components: [
      { type: "BODY", text: "Oi, {{1}}! 😊" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Quero agendar" },
          { type: "QUICK_REPLY", text: "Me lembrar depois" },
          { type: "QUICK_REPLY", text: "Tenho uma dúvida" },
        ],
      },
    ],
    metaVariableMappings: { "1": "name" },
  });
  assert("draft has nome var", draft.visibleBody.includes("{nome}"));
  assert("draft has numbered 1", draft.visibleBody.includes("1 - Quero agendar"));
  assert("draft has numbered 3", draft.visibleBody.includes("3 - Tenho uma dúvida"));
  assert("draft response options count", draft.responseOptions.length === 3);
  assert("draft intent 1 interested", draft.responseOptions[0]?.intent === "interested");
  assert("draft intent 2 unknown", draft.responseOptions[1]?.intent === "unknown");
}

// metadados embutidos round-trip
{
  const stored = serializeTemplateMessageBody("Corpo visível", {
    description: "Teste",
    responseOptions: [{ n: 1, label: "Sim", intent: "interested" }],
  });
  const parsed = parseTemplateMessageBody(stored);
  assert("metadata roundtrip body", parsed.visibleBody === "Corpo visível");
  assert("metadata roundtrip desc", parsed.meta.description === "Teste");
  assert("strip metadata", stripTemplateMetadata(stored) === "Corpo visível");
}

// classificação respostas numeradas
{
  assert("reply 1 interested", classifyCampaignResponse("1") === "interested");
  assert("reply 2 unknown", classifyCampaignResponse("2") === "unknown");
  assert("reply 3 interested", classifyCampaignResponse("3") === "interested");
  assert("reply quero agendar", classifyCampaignResponse("Quero agendar") === "interested");
  assert("opt_out sair", classifyCampaignResponse("SAIR") === "opt_out");
  assert("opt_out parar", classifyCampaignResponse("PARAR") === "opt_out");
  assert("opt_out cancelar", classifyCampaignResponse("CANCELAR") === "opt_out");
}

// variáveis dinâmicas ilimitadas
{
  const {
    extractEvolutionTemplateVariables,
    buildDefaultEvolutionMappings,
    resolveAndRenderEvolutionTemplate,
    packEvolutionMappings,
    unpackEvolutionMappings,
    listUnconfiguredEvolutionVariables,
  } = await import("../src/lib/campaign-evolution-variables.ts");

  const tpl =
    "Olá {nome}, seu {produto} em {cidade} — valor {valor_servico}. Atendente: {nome_atendente}";
  const vars = extractEvolutionTemplateVariables(tpl);
  assert("extract dynamic vars count", vars.length === 5);
  assert("extract valor_servico", vars.includes("valor_servico"));
  assert("extract cidade", vars.includes("cidade"));

  const defaults = buildDefaultEvolutionMappings(tpl);
  assert("default mapping nome", defaults.nome?.source === "contact_field");

  const ok = resolveAndRenderEvolutionTemplate(tpl, defaults, {
    contact: {
      name: "Ana",
      phone: "5534999999999",
      variables: { produto: "Refil", cidade: "Uberaba", valor_servico: "R$ 99" },
    },
    attendant: { name: "Josyane" },
    company: { name: "Empresa X" },
  });
  assert("resolve ok", ok.ok === true);
  if (ok.ok) {
    assert("rendered no braces", !/\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(ok.rendered));
    assert("rendered has Ana", ok.rendered.includes("Ana"));
  }

  const fail = resolveAndRenderEvolutionTemplate(tpl, defaults, {
    contact: { name: "Ana", phone: "5534999999999", variables: { produto: "Refil" } },
    attendant: { name: "Josyane" },
    company: { name: "Empresa X" },
  });
  assert("resolve missing vars", fail.ok === false);
  if (!fail.ok) {
    assert("missing includes cidade", fail.missing.includes("cidade"));
    assert("missing includes valor_servico", fail.missing.includes("valor_servico"));
  }

  const packed = packEvolutionMappings({ "1": "name" }, defaults);
  const unpacked = unpackEvolutionMappings(packed);
  assert("pack unpack roundtrip", unpacked.nome?.source === "contact_field");
  assert("meta flat preserved in pack", typeof packed["1"] === "string");

  const check = listUnconfiguredEvolutionVariables(tpl, {});
  assert("validate unconfigured fails", check.length === vars.length);
}

// opções numeradas format
{
  const block = formatNumberedResponseBlock([
    { n: 1, label: "Quero agendar", intent: "interested" },
    { n: 2, label: "Me lembrar depois", intent: "unknown" },
  ]);
  assert("numbered block header", block.includes("Responda:"));
  assert("numbered block line 2", block.includes("2 - Me lembrar depois"));
}

// campanha integrada — 3 contatos, 5 variáveis, confirmação e CRM
{
  const {
    resolveAndRenderEvolutionTemplate,
    packEvolutionMappings,
    unpackEvolutionMappingsBlock,
    validateEvolutionMappingsConfigured,
    markEvolutionMappingConfirmed,
    listUnconfirmedEvolutionVariables,
  } = await import("../src/lib/campaign-evolution-variables.ts");
  const { parseSpreadsheetRow, buildCrmContactVariables } = await import(
    "../src/lib/campaign-spreadsheet.ts"
  );

  const MSG = `Olá, {nome}!

Seu produto {produto} custa {valor_troca}.
Atendimento por {nome_atendente}, da empresa {nome_empresa}.`;

  const mappings = {
    nome: { source: "contact_field", field: "name", confirmed: true },
    produto: { source: "contact_variable", key: "produto", confirmed: true },
    valor_troca: { source: "spreadsheet_column", column: "valor_troca", confirmed: true },
    nome_atendente: { source: "attendant", field: "name", confirmed: true },
    nome_empresa: { source: "company", field: "name", confirmed: true },
  };

  const company = { name: "Acme Ltda" };
  const attendant = { name: "Carlos Silva" };

  function row(data, includeValor = true) {
    const parsed = parseSpreadsheetRow(data, 0);
    const vars = { ...parsed.variables, produto: data.produto };
    if (!includeValor) delete vars.valor_troca;
    return { name: parsed.name, phone: parsed.phone, variables: vars };
  }

  const c1 = row({ nome: "Ana", telefone: "5534111111111", produto: "Refil A", VALOR_TROCA: "R$ 120,00" });
  const c2 = row({ nome: "Bruno", telefone: "5534222222222", produto: "Refil B", VALOR_TROCA: "" }, false);
  const c3 = row({ nome: "Carla", telefone: "5534333333333", produto: "Refil C", VALOR_TROCA: "R$ 89,50" });

  const PLACEHOLDER_RE = /\{[a-zA-Z_][a-zA-Z0-9_]*\}/;

  const r1 = resolveAndRenderEvolutionTemplate(MSG, mappings, {
    contact: c1,
    attendant,
    company,
  });
  assert("integrated c1 ok", r1.ok === true);
  if (r1.ok) {
    assert("integrated c1 sendable", !PLACEHOLDER_RE.test(r1.rendered));
    assert("integrated c1 content", r1.rendered.includes("Ana") && r1.rendered.includes("120"));
  }

  const r2 = resolveAndRenderEvolutionTemplate(MSG, mappings, {
    contact: c2,
    attendant,
    company,
  });
  assert("integrated c2 fail only contact", r2.ok === false);
  if (!r2.ok) assert("integrated c2 missing valor_troca", r2.missing.includes("valor_troca"));

  const r3 = resolveAndRenderEvolutionTemplate(MSG, mappings, {
    contact: c3,
    attendant,
    company,
  });
  assert("integrated c3 ok", r3.ok === true);
  if (r3.ok) {
    assert("integrated c3 personalized", r3.rendered.includes("Carla") && r3.rendered.includes("89,50"));
    assert("integrated c3 distinct from c1", !r3.rendered.includes("Ana"));
    assert("integrated c3 sendable", !PLACEHOLDER_RE.test(r3.rendered));
  }

  const crmVars = buildCrmContactVariables({
    email: "ana@acme.com",
    reference: "Cliente VIP",
    tags: ["produto"],
  });
  assert("crm copies email", crmVars.email === "ana@acme.com");
  assert("crm copies reference", crmVars.reference === "Cliente VIP");
  assert("crm tag as variable key", crmVars.produto === "produto");

  const crmResolve = resolveAndRenderEvolutionTemplate("Produto {produto}", mappings, {
    contact: { name: "Ana", phone: "5534111111111", variables: crmVars },
    attendant,
    company,
  });
  assert("crm produto via contact_variable", crmResolve.ok === true);
  if (crmResolve.ok) assert("crm rendered produto", crmResolve.rendered.includes("produto"));

  const suggested = {
    nome: { source: "contact_field", field: "name", confirmed: false },
  };
  const unconfirmedCheck = validateEvolutionMappingsConfigured(MSG, suggested, {
    requiresConfirmation: true,
  });
  assert("unconfirmed blocks schedule", unconfirmedCheck.ok === false);
  assert(
    "unconfirmed lists vars",
    listUnconfirmedEvolutionVariables(MSG, suggested).length === 5,
  );

  const packed = packEvolutionMappings({}, mappings, { requiresConfirmation: true });
  const block = unpackEvolutionMappingsBlock(packed);
  assert("packed requires confirmation", block.requiresConfirmation === true);
  assert("packed preserves confirmed", block.mappings.nome?.confirmed === true);

  const legacyBlock = unpackEvolutionMappingsBlock({});
  const legacyCheck = validateEvolutionMappingsConfigured("Oi {nome}", {
    nome: markEvolutionMappingConfirmed({ source: "contact_field", field: "name" }),
  });
  assert("legacy without requires flag passes", legacyCheck.ok === true);
  assert("legacy block no confirmation required", legacyBlock.requiresConfirmation === false);
}

// schema atual sem companies.trade_name — mapeamentos legados e contexto mínimo
{
  const { resolveEvolutionVariableValue, resolveAndRenderEvolutionTemplate } = await import(
    "../src/lib/campaign-evolution-variables.ts"
  );

  const companyCtx = { name: "Acme Ltda" };

  const legacyTradeName = resolveEvolutionVariableValue(
    "empresa",
    { source: "company", field: "trade_name" },
    { contact: { name: "Ana", phone: "5534111111111", variables: {} }, company: companyCtx },
  );
  assert("legacy trade_name uses companies.name", legacyTradeName === "Acme Ltda");

  const legacyPhone = resolveEvolutionVariableValue(
    "tel_empresa",
    { source: "company", field: "phone" },
    { contact: { name: "Ana", phone: "5534111111111", variables: {} }, company: companyCtx },
  );
  assert("legacy company phone absent returns null", legacyPhone === null);

  const rendered = resolveAndRenderEvolutionTemplate(
    "Empresa {nome_empresa}",
    { nome_empresa: { source: "company", field: "trade_name", confirmed: true } },
    { contact: { name: "Ana", phone: "5534111111111", variables: {} }, company: companyCtx },
  );
  assert("render with legacy trade_name mapping ok", rendered.ok === true);
  if (rendered.ok) {
    assert("render with legacy trade_name uses name", rendered.rendered.includes("Acme Ltda"));
  }
}

console.log(
  failed === 0
    ? "\nAll campaign template tests passed."
    : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
