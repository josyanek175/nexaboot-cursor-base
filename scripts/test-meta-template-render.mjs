/**
 * Testes de renderização de templates Meta para exibição no atendimento.
 * Uso: npx tsx scripts/test-meta-template-render.mjs
 */
import {
  buildMetaTemplateOutboundFallback,
  describeTemplateComponents,
  ensureMetaTemplateOutboundBody,
  isLegacyMetaTemplatePlaceholder,
  normalizeTemplateComponents,
  parseMessageRawPayload,
  renderMetaTemplateFromComponents,
  renderMetaTemplateMessage,
  resolveMetaTemplateDisplayForMessage,
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

const SAMPLE_JSON_STRING = JSON.stringify(SAMPLE_COMPONENTS);

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

// components como array
{
  const rendered = renderMetaTemplateFromComponents({
    components: SAMPLE_COMPONENTS,
    parameters: ["Josyane"],
  });
  assert("array components body", rendered.body.includes("Oi, Josyane!"));
  assert("array newline preserved", rendered.body.includes("\n\nPassando para lembrar"));
  assert("array emoji preserved", rendered.body.includes("😊"));
  assert("array buttons count", rendered.buttons.length === 3);
}

// components como JSON string
{
  const rendered = renderMetaTemplateFromComponents({
    components: SAMPLE_JSON_STRING,
    parameters: ["Josyane"],
  });
  assert("json string body", rendered.body.includes("Oi, Josyane!"));
  assert("json string buttons", rendered.buttons.length === 3);
}

// BODY em minúsculo
{
  const rendered = renderMetaTemplateFromComponents({
    components: [{ type: "body", text: "Olá {{1}}" }],
    parameters: ["Maria"],
  });
  assert("lowercase body type", rendered.body === "Olá Maria");
}

// body com {{1}} e três botões
{
  const rendered = renderMetaTemplateFromComponents({
    components: SAMPLE_COMPONENTS,
    parameters: ["Josyane"],
  });
  assert("button 1", rendered.buttons[0] === "Quero agendar");
  assert("button 3", rendered.buttons[2] === "Tenho uma dúvida");
}

// metadata como objeto
{
  const rendered = renderMetaTemplateFromComponents({
    components: SAMPLE_COMPONENTS,
    parameters: ["Josyane"],
  });
  const payload = {
    origin: "CAMPANHA",
    meta_template: {
      template_name: "abordagem_inicial_troca_refil",
      template_language: "pt_BR",
      template_components: SAMPLE_COMPONENTS,
      body_parameters: ["Josyane"],
      template_buttons: rendered.buttons,
    },
  };
  assert("metadata template_name", payload.meta_template.template_name === "abordagem_inicial_troca_refil");
  assert("metadata buttons", payload.meta_template.template_buttons.length === 3);
  assert("body not placeholder", !rendered.body.startsWith("[Template Meta:"));
}

// raw_payload como string JSON
{
  const payload = {
    meta_template: {
      template_name: "abordagem_inicial_troca_refil",
      template_components: SAMPLE_JSON_STRING,
      body_parameters: ["Josyane"],
    },
  };
  const parsed = parseMessageRawPayload(JSON.stringify(payload));
  const resolved = resolveMetaTemplateDisplayForMessage({
    messageText: "",
    metaTemplate: parsed.meta_template,
  });
  assert("raw payload string parsed", resolved.body.includes("Oi, Josyane!"));
  assert("raw payload source meta", resolved.source === "meta_template");
}

// body ausente — não inventa texto completo
{
  const rendered = renderMetaTemplateFromComponents({
    components: [{ type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Ok" }] }],
    parameters: ["Josyane"],
  });
  assert("missing body not rendered", rendered.rendered === false);
  assert("missing body empty", rendered.body === "");
}

// impedir balão vazio na persistência
{
  const ensured = ensureMetaTemplateOutboundBody({
    renderedBody: "",
    templateName: "abordagem_inicial_troca_refil",
  });
  assert("outbound fallback used", ensured.usedFallback === true);
  assert(
    "outbound fallback text",
    ensured.body === "Template Meta enviado: abordagem_inicial_troca_refil",
  );
}

// placeholder legado com metadata suficiente
{
  const resolved = resolveMetaTemplateDisplayForMessage({
    messageText: "[Template Meta: abordagem_inicial_troca_refil/pt_BR] Josyane",
    metaTemplate: {
      template_name: "abordagem_inicial_troca_refil",
      template_components: SAMPLE_COMPONENTS,
      body_parameters: ["Josyane"],
    },
  });
  assert("legacy with metadata rerender", resolved.body.includes("Oi, Josyane!"));
  assert("legacy with metadata source", resolved.source === "meta_template");
}

// placeholder legado sem metadata
{
  const resolved = resolveMetaTemplateDisplayForMessage({
    messageText: "[Template Meta: abordagem_inicial_troca_refil/pt_BR] Josyane",
    metaTemplate: null,
  });
  assert("legacy without metadata kept", resolved.source === "legacy_placeholder");
  assert(
    "legacy without metadata text",
    resolved.body.startsWith("[Template Meta:"),
  );
}

// mensagem vazia com metadata — re-render
{
  const resolved = resolveMetaTemplateDisplayForMessage({
    messageText: "",
    metaTemplate: {
      template_name: "abordagem_inicial_troca_refil",
      template_components: SAMPLE_JSON_STRING,
      body_parameters: ["Josyane"],
      template_buttons: ["Quero agendar"],
    },
  });
  assert("empty message rerender", resolved.body.includes("refil"));
  assert("empty message buttons", resolved.buttons.length === 1);
}

// normalize wrapper { components: [...] }
{
  const normalized = normalizeTemplateComponents({ components: SAMPLE_COMPONENTS });
  assert("wrapper normalize count", normalized?.length === 2);
}

// describe components diagnostics
{
  const diag = describeTemplateComponents(SAMPLE_JSON_STRING);
  assert("diag array type", diag.componentsType === "array");
  assert("diag has body", diag.hasBodyComponent === true);
  assert("diag count", diag.componentsCount === 2);
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

assert(
  "legacy placeholder detect",
  isLegacyMetaTemplatePlaceholder("[Template Meta: foo/pt_BR] Josyane"),
);
assert(
  "fallback detect",
  buildMetaTemplateOutboundFallback("abordagem_inicial_troca_refil").includes("abordagem_inicial_troca_refil"),
);

console.log(
  failed === 0
    ? "\nAll meta template render tests passed."
    : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
