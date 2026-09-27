import assert from "node:assert/strict";
import {
  matchChoice,
  replyMatches,
  validateDefinition,
} from "../src/lib/automation-flow.ts";

const ok = validateDefinition({
  entryStepId: "inicio",
  steps: [
    {
      id: "inicio",
      type: "buttons",
      text: "Oi {{nome}}",
      buttons: [
        { id: "a", label: "Quero agendar", next: "fim" },
        { id: "b", label: "Tenho uma dúvida", next: null },
      ],
    },
    { id: "fim", type: "end", text: "Até logo" },
  ],
});
assert.equal(ok.ok, true);
assert.equal(matchChoice("1", ok.ok ? ok.definition.steps[0].type === "buttons" ? ok.definition.steps[0].buttons : [] : [])?.label, "Quero agendar");
assert.equal(matchChoice("tenho uma dúvida", ok.ok && ok.definition.steps[0].type === "buttons" ? ok.definition.steps[0].buttons : [])?.id, "b");
assert.equal(matchChoice("outra", ok.ok && ok.definition.steps[0].type === "buttons" ? ok.definition.steps[0].buttons : []), null);
assert.equal(replyMatches("Sim, continua", "sim"), true);
assert.equal(replyMatches("mudei a rua", "sim"), false);

const tooMany = validateDefinition({
  entryStepId: "a",
  steps: [{ id: "a", type: "buttons", text: "x", buttons: [
    { id: "1", label: "a", next: null },
    { id: "2", label: "b", next: null },
    { id: "3", label: "c", next: null },
    { id: "4", label: "d", next: null },
  ] }],
});
assert.equal(tooMany.ok, false);
console.log("automation flow ok");
