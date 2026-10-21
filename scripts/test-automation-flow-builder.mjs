import assert from "node:assert/strict";
import { stepById, validateDefinition } from "../src/lib/automation-flow.ts";

const saved = validateDefinition({
  entryStepId: "msg",
  steps: [
    { id: "msg", name: "Boas-vindas", type: "message", text: "Oi {{nome}}", next: "btn" },
    {
      id: "btn",
      type: "buttons",
      text: "Como ajudar?",
      buttons: [{ id: "a", label: "Agendar", next: "fim" }],
    },
    { id: "fim", type: "goto", next: "msg" },
  ],
});
assert.equal(saved.ok, true);
if (saved.ok) {
  assert.equal(stepById(saved.definition, "msg")?.type, "message");
  const noName = saved.definition.steps.find((step) => step.id === "btn");
  assert.equal(noName && "name" in noName ? noName.name : undefined, undefined);
}

const broken = validateDefinition({
  entryStepId: "x",
  steps: [{ id: "x", type: "message", text: "Oi", next: "nao-existe" }],
});
assert.equal(broken.ok, false);
console.log("automation flow builder types ok");
