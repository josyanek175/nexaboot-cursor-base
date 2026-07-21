/**
 * Testes controlados — templates Meta / campanhas (sem rede Meta obrigatória).
 *
 * Uso: node scripts/test-meta-template-campaign.mjs
 */
import assert from "node:assert/strict";

// Cópia espelhada da lógica pura (evita carregar TS/server no Node puro).
function extractTemplateVariables(components) {
  if (!Array.isArray(components)) return [];
  let body = "";
  for (const c of components) {
    if (c && typeof c === "object" && String(c.type ?? "").toUpperCase() === "BODY") {
      body = typeof c.text === "string" ? c.text : "";
    }
  }
  const found = new Set();
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) found.add(m[1]);
  return [...found].sort((a, b) => Number(a) - Number(b));
}

function resolveMetaTemplateParam(fieldKey, contact) {
  const key = fieldKey.trim().toLowerCase();
  const vars = contact.variables ?? {};
  if (key === "name" || key === "nome") {
    return String(contact.name ?? vars.nome ?? vars.name ?? "").trim();
  }
  if (key === "phone" || key === "telefone") {
    return String(contact.phone ?? vars.telefone ?? vars.phone ?? "").replace(/\D+/g, "");
  }
  const fromVars = vars[fieldKey] ?? vars[key];
  if (fromVars != null && String(fromVars).trim()) return String(fromVars).trim();
  return "";
}

function buildMetaTemplateBodyParameters(opts) {
  const extracted = extractTemplateVariables(opts.components);
  let orderedKeys = extracted;
  if (orderedKeys.length === 0 && opts.templateName === "abordagem_inicial_troca_refil") {
    orderedKeys = ["1"];
  }
  const parameters = [];
  for (const key of orderedKeys) {
    let field = opts.mappings[key]?.trim() || "";
    if (!field && opts.templateName === "abordagem_inicial_troca_refil" && key === "1") {
      field = "name";
    }
    if (!field) field = "name";
    let value = resolveMetaTemplateParam(field, opts.contact);
    if (!value && (field === "name" || field === "nome") && key === "1") {
      value = "Cliente";
    }
    if (!value) {
      return { ok: false, error: `empty_template_param_{{${key}}}`, emptyKey: key };
    }
    parameters.push(value);
  }
  return { ok: true, parameters, orderedKeys };
}

function normalizePhoneE164(raw, options) {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.startsWith("55") && digits.length >= 12) return digits;
  if (options?.defaultCountry === "BR") {
    if (/^\d{2}9\d{8}$/.test(digits) || /^\d{2}\d{8}$/.test(digits)) {
      if (!digits.startsWith("555")) return `55${digits}`;
    }
  }
  return digits;
}

function buildGraphPayload(to, templateName, languageCode, bodyParameters) {
  const template = {
    name: templateName,
    language: { code: languageCode },
  };
  if (bodyParameters.length > 0) {
    template.components = [
      {
        type: "body",
        parameters: bodyParameters.map((text) => ({ type: "text", text })),
      },
    ];
  }
  return {
    messaging_product: "whatsapp",
    to: String(to).replace(/\D/g, ""),
    type: "template",
    template,
  };
}

// --- 1) Variáveis abordagem_inicial_troca_refil {{1}} → nome ---
{
  const components = [
    {
      type: "BODY",
      text: "Olá {{1}}, temos uma oferta de troca de refil.",
    },
    {
      type: "BUTTONS",
      buttons: [{ type: "QUICK_REPLY", text: "Quero saber mais" }],
    },
  ];
  const built = buildMetaTemplateBodyParameters({
    templateName: "abordagem_inicial_troca_refil",
    components,
    mappings: { "1": "name" },
    contact: { name: "Maria Silva", phone: "34999708837" },
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.orderedKeys, ["1"]);
  assert.deepEqual(built.parameters, ["Maria Silva"]);
  const payload = buildGraphPayload(
    "5534999708837",
    "abordagem_inicial_troca_refil",
    "pt_BR",
    built.parameters,
  );
  assert.equal(payload.to, "5534999708837");
  assert.equal(payload.template.name, "abordagem_inicial_troca_refil");
  assert.equal(payload.template.language.code, "pt_BR");
  assert.equal(payload.template.components[0].parameters[0].text, "Maria Silva");
  assert.ok(!JSON.stringify(payload).includes("+"));
  console.log("OK payload {{1}}=nome");
}

// --- 2) Ordem {{1}},{{2}},{{3}} ---
{
  const components = [{ type: "BODY", text: "Oi {{1}}, produto {{2}}, loja {{3}}" }];
  const built = buildMetaTemplateBodyParameters({
    templateName: "outro",
    components,
    mappings: { "1": "name", "2": "produto", "3": "loja" },
    contact: {
      name: "Ana",
      variables: { produto: "Refil", loja: "Uberlândia" },
    },
  });
  assert.deepEqual(built.parameters, ["Ana", "Refil", "Uberlândia"]);
  console.log("OK ordem {{1}}{{2}}{{3}}");
}

// --- 3) Rejeita parâmetro vazio (exceto fallback {{1}} nome) ---
{
  const components = [{ type: "BODY", text: "Produto {{2}}" }];
  const built = buildMetaTemplateBodyParameters({
    templateName: "outro",
    components,
    mappings: { "2": "produto" },
    contact: { name: "Ana", variables: {} },
  });
  assert.equal(built.ok, false);
  assert.match(built.error, /empty_template_param/);
  console.log("OK rejeita vazio");
}

// --- 4) Telefone E.164 sem duplicar 55 ---
{
  assert.equal(normalizePhoneE164("+55 (34) 99970-8837", { defaultCountry: "BR" }), "5534999708837");
  assert.equal(normalizePhoneE164("5534999708837", { defaultCountry: "BR" }), "5534999708837");
  assert.equal(normalizePhoneE164("34999708837", { defaultCountry: "BR" }), "5534999708837");
  console.log("OK telefone E.164");
}

// --- 5) Simulação dedupe concorrente (claim atômico) ---
{
  const row = { status: "pending", provider_message_id: null, sends: 0 };
  function claim() {
    if (row.status !== "pending" || row.provider_message_id) return false;
    row.status = "processing";
    return true;
  }
  function sendIfClaimed(claimed) {
    if (!claimed) return false;
    if (row.status === "sent" || row.provider_message_id) return false;
    row.sends += 1;
    row.provider_message_id = "wamid.TEST";
    row.status = "sent";
    return true;
  }
  const c1 = claim();
  const c2 = claim(); // segundo tick não reserva
  assert.equal(c1, true);
  assert.equal(c2, false);
  assert.equal(sendIfClaimed(c1), true);
  assert.equal(sendIfClaimed(c2), false);
  assert.equal(row.sends, 1);
  console.log("OK dois ticks → um envio");
}

console.log("\nTodos os testes controlados passaram.");
