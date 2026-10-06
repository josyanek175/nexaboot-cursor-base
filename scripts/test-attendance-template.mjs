/**
 * Testes do módulo de templates no atendimento.
 * Uso: npx tsx scripts/test-attendance-template.mjs
 */
import {
  buildOrderedTemplateParameters,
  evaluateAttendanceTemplateSendGuards,
  mergeAttendanceTemplateRawPayload,
  normalizeAttendanceVariables,
  previewAttendanceTemplateBody,
  resolveAttendanceVariableDefaults,
} from "../src/lib/attendance-template.ts";

let failed = 0;
function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

// 1) preview 1, 2, 3 vars
assert(
  "preview 1 var",
  previewAttendanceTemplateBody("Olá, {{1}}!", { 1: "Maria" }) === "Olá, Maria!",
);
assert(
  "preview 2 vars",
  previewAttendanceTemplateBody("Olá, {{1}}! Sobre {{2}}.", { 1: "Maria", 2: "filtro" }) ===
    "Olá, Maria! Sobre filtro.",
);
assert(
  "preview 3 vars",
  previewAttendanceTemplateBody(
    "Olá, {{1}}! Temos uma atualização sobre sua solicitação {{2}}: {{3}}.",
    { 1: "Maria", 2: "Troca do filtro", 3: "A peça chegou" },
  ) ===
    "Olá, Maria! Temos uma atualização sobre sua solicitação Troca do filtro: A peça chegou.",
);

// 2) ordem dos parâmetros
const vars = normalizeAttendanceVariables([
  { position: 2, label: "B", type: "text", source: "manual", required: true },
  { position: 1, label: "A", type: "text", source: "customer_name", required: true },
  { position: 3, label: "C", type: "textarea", source: "manual", required: true },
]);
const built = buildOrderedTemplateParameters(vars, {
  1: "Maria",
  2: "Solicitação",
  3: "Atualização",
});
assert("order ok", built.ok === true && built.parameters.join("|") === "Maria|Solicitação|Atualização");

// 3) required vazio
const empty = buildOrderedTemplateParameters(vars, { 1: "Maria", 2: "", 3: "x" });
assert("required empty", empty.ok === false && empty.missingPosition === 2);

// 9) customer_name automático
const defaults = resolveAttendanceVariableDefaults({
  variables: vars,
  contactName: "João Silva",
});
assert("customer_name default", defaults[1] === "João Silva" && defaults[2] === "");

// original template intact
const original = "Olá, {{1}}!";
previewAttendanceTemplateBody(original, { 1: "X" });
assert("original unchanged", original === "Olá, {{1}}!");

const baseGuard = {
  authCompanyId: "co-a",
  conversationCompanyId: "co-a",
  presetCompanyId: "co-a",
  metaCompanyId: "co-a",
  channelType: "meta",
  conversationChannelId: "ch-1",
  metaChannelId: "ch-1",
  presetActive: true,
  metaActive: true,
  metaStatus: "APPROVED",
};
assert("meta allowed", evaluateAttendanceTemplateSendGuards(baseGuard).ok === true);
assert(
  "other company template blocked",
  evaluateAttendanceTemplateSendGuards({ ...baseGuard, presetCompanyId: "co-b" }).error ===
    "forbidden_company",
);
assert(
  "other company conversation blocked",
  evaluateAttendanceTemplateSendGuards({ ...baseGuard, conversationCompanyId: "co-b" }).error ===
    "conversation_wrong_company",
);
assert(
  "not APPROVED blocked",
  evaluateAttendanceTemplateSendGuards({ ...baseGuard, metaStatus: "PENDING" }).error ===
    "meta_template_not_approved",
);
assert(
  "Evolution blocked",
  evaluateAttendanceTemplateSendGuards({ ...baseGuard, channelType: "evolution" }).error ===
    "channel_not_meta",
);
assert(
  "inactive blocked",
  evaluateAttendanceTemplateSendGuards({ ...baseGuard, presetActive: false }).error ===
    "template_inactive",
);

// dedupe payload merge
const echoFirst = mergeAttendanceTemplateRawPayload(
  { origin: "echo", foo: 1 },
  { origin: "attendance_template", meta_template_name: "x", template_parameters: ["a"] },
);
assert(
  "echo then crm merges attendance",
  echoFirst.origin === "attendance_template" && echoFirst.foo === 1,
);
const crmFirst = mergeAttendanceTemplateRawPayload(
  { origin: "attendance_template", meta_template_name: "x", sent_by: "u1" },
  { origin: "whatsapp_business_app", bar: 2 },
);
assert(
  "crm then echo keeps attendance",
  crmFirst.origin === "attendance_template" && crmFirst.sent_by === "u1",
);

if (failed > 0) {
  console.error(`\n${failed} teste(s) falharam`);
  process.exit(1);
}
console.log("\nTodos os testes de attendance-template passaram.");
