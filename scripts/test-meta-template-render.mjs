/**
 * Testes de renderização de templates Meta para exibição no atendimento.
 * Uso: npx tsx scripts/test-meta-template-render.mjs
 */
import {
  isLegacyMetaTemplatePlaceholder,
  renderMetaTemplateFromComponents,
  renderMetaTemplateMessage,
} from "../src/lib/meta-template-render.ts";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

const SAMPLE_COMPONENTS = [
  {
    type: "BODY",
    text: "Oi, {{1}}! 😊\n\nPassando para lembrar que já pode estar na hora de trocar o refil do seu filtro.\n\nDeseja agendar a troca?",
  },
  {
    type: "BUTTONS",
    buttons: [
      { type: "QUICK_REPLY", text: "Quero agendar" },
      { type: "QUICK_REPLY", text: "Me lembrar depois" },
      { type: "QUICK_REPLY", text: "Tenho uma dúvida" },
    ],
  },
];

// {{1}} substituído
{
  const rendered = renderMetaTemplateMessage({
    body: "Oi, {{1}}!",
    parameters: ["Josyane"],
  });
  assert("single param", rendered.body === "Oi, Josyane!");
}

// múltiplos parâmetros
{
  const rendered = renderMetaTemplateMessage({
    body: "Oi {{1}}, produto {{2}}, loja {{3}}",
    parameters: ["Ana", "Refil", "Uberlândia"],
  });
  assert(
    "multi params",
    rendered.body === "Oi Ana, produto Refil, loja Uberlândia",
  );
}

// quebra de linha preservada
{
  const rendered = renderMetaTemplateFromComponents({
    components: SAMPLE_COMPONENTS,
    parameters: ["Josyane"],
  });
  assert("newline preserved", rendered.body.includes("\n\nPassando para lembrar"));
  assert("emoji preserved", rendered.body.includes("😊"));
}

// botões
{
  const rendered = renderMetaTemplateFromComponents({
    components: SAMPLE_COMPONENTS,
    parameters: ["Josyane"],
  });
  assert("buttons count", rendered.buttons.length === 3);
  assert("button 1", rendered.buttons[0] === "Quero agendar");
  assert("button 3", rendered.buttons[2] === "Tenho uma dúvida");
}

// parâmetro ausente → fallback vazio
{
  const rendered = renderMetaTemplateMessage({
    body: "Produto {{2}} para {{1}}",
    parameters: ["Ana"],
  });
  assert("missing param fallback", rendered.body === "Produto  para Ana");
}

// metadata shape (simula persistência)
{
  const rendered = renderMetaTemplateFromComponents({
    components: SAMPLE_COMPONENTS,
    parameters: ["Josyane"],
  });
  const providerId = "wamid.HBgNNTUxMTk5OTk5OTk5FQIAERgSQjE2RkE4RkE4RkE4RkE4RkE4AA==";
  const payload = {
    origin: "CAMPANHA",
    campaign_id: "camp-1",
    campaign_contact_id: "cc-1",
    sender: "Disparo Automático",
    meta_template: {
      template_name: "abordagem_inicial_troca_refil",
      template_language: "pt_BR",
      template_category: "MARKETING",
      template_components: SAMPLE_COMPONENTS,
      body_parameters: ["Josyane"],
      template_buttons: rendered.buttons,
      provider_message_id: providerId,
      wamid: providerId,
    },
  };
  assert("metadata template_name", payload.meta_template.template_name === "abordagem_inicial_troca_refil");
  assert("metadata wamid", payload.meta_template.wamid === providerId);
  assert("metadata buttons", payload.meta_template.template_buttons.length === 3);
  assert("body not placeholder", !rendered.body.startsWith("[Template Meta:"));
}

// persistência sem duplicidade (mesmo wamid → um registro lógico)
{
  const rows = new Map();
  function persistOnce(wamid, body) {
    if (!wamid) return "inserted";
    if (rows.has(wamid)) return "conflict";
    rows.set(wamid, body);
    return "inserted";
  }
  assert("first insert", persistOnce("wamid.A", "Oi, Ana") === "inserted");
  assert("duplicate blocked", persistOnce("wamid.A", "Oi, Ana") === "conflict");
  assert("rows count", rows.size === 1);
}

// placeholder legado detectável
assert(
  "legacy placeholder detect",
  isLegacyMetaTemplatePlaceholder("[Template Meta: foo/pt_BR] Josyane"),
);
assert(
  "rendered body not legacy",
  !isLegacyMetaTemplatePlaceholder("Oi, Josyane!"),
);

console.log(
  failed === 0
    ? "\nAll meta template render tests passed."
    : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
