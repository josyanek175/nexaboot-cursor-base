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

// opções numeradas format
{
  const block = formatNumberedResponseBlock([
    { n: 1, label: "Quero agendar", intent: "interested" },
    { n: 2, label: "Me lembrar depois", intent: "unknown" },
  ]);
  assert("numbered block header", block.includes("Responda:"));
  assert("numbered block line 2", block.includes("2 - Me lembrar depois"));
}

console.log(
  failed === 0
    ? "\nAll campaign template tests passed."
    : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
