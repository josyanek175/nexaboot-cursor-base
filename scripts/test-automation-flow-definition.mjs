import assert from "node:assert/strict";
import { readStoredDefinition, validateDefinition } from "../src/lib/automation-flow.ts";

const definition = {
  entryStepId: "msg",
  steps: [
    { id: "msg", name: "Boas-vindas", type: "message", text: "Oi", next: "botoes" },
    {
      id: "botoes",
      name: "Escolha",
      type: "buttons",
      text: "Como ajudar?",
      buttons: [
        { id: "b1", label: "Agendar", next: "texto" },
        { id: "b2", label: "Encerrar", next: "fim" },
      ],
    },
    { id: "texto", name: "Endereco", type: "ask_text", text: "Qual endereco?", saveAs: "endereco", next: "cond" },
    { id: "cond", name: "Confirma", type: "condition", match: "sim", yesNext: "atalho", noNext: "fim" },
    { id: "atalho", name: "Volta", type: "goto", next: "fim" },
    { id: "fim", name: "Fim", type: "end", text: "Ate logo" },
  ],
};

const stored = validateDefinition(definition);
assert.equal(stored.ok, true);
if (!stored.ok) throw new Error("save validation failed");

const fromObject = readStoredDefinition(stored.definition, { id: "flow-1", name: "Teste" });
const fromString = readStoredDefinition(JSON.stringify(stored.definition), { id: "flow-1", name: "Teste" });
assert.deepEqual(fromObject, stored.definition);
assert.deepEqual(fromString, stored.definition);
assert.deepEqual(fromObject, fromString);

const empty = readStoredDefinition({ entryStepId: null, steps: [] }, { id: "vazio", name: "Vazio" });
assert.deepEqual(empty, { entryStepId: null, steps: [] });

let failed = false;
try {
  readStoredDefinition(
    { entryStepId: "x", steps: [{ id: "x", type: "wait", text: "a", next: null }] },
    { id: "ruim", name: "Ruim" },
  );
} catch (error) {
  failed = true;
  assert.equal(error.name, "FlowDefinitionError");
  assert.match(error.message, /desconhecido/);
  assert.equal(error.flowId, "ruim");
  assert.deepEqual(error.stepTypes, ["wait"]);
  assert.notDeepEqual(error, { steps: [] });
}
assert.equal(failed, true);
console.log("definition roundtrip ok");
