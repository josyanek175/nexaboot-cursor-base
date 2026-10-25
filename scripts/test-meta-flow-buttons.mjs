import assert from "node:assert/strict";
import { tsLoader } from "./test-support/isolated-postgres.mjs";
const load = tsLoader();
const { metaTextPayload } = load("src/lib/meta-reply-buttons.ts");
const { matchChoice } = load("src/lib/automation-flow.ts");
const choices = [
  { id: "sales", label: "Vendas" },
  { id: "support", label: "Suporte" },
];
assert.equal(metaTextPayload("Olá", choices).type, "interactive");
assert.deepEqual(metaTextPayload("Olá", choices).interactive.action.buttons[1], {
  type: "reply",
  reply: { id: "support", title: "Suporte" },
});
assert.equal(metaTextPayload("Texto").type, "text");
assert.equal(matchChoice("support", choices).id, "support");
assert.equal(matchChoice("2", choices).id, "support");
assert.throws(() => metaTextPayload("x".repeat(1025), choices));
assert.throws(() => metaTextPayload("Olá", [...choices, ...choices]));
assert.throws(() => metaTextPayload("Olá", [{ id: "a", label: "x".repeat(21) }]));
assert.throws(() =>
  metaTextPayload("Olá", [
    { id: "a", label: "Mesmo" },
    { id: "b", label: "Mesmo" },
  ]),
);
console.log("PASS: Meta reply-button payload, limits and choice matching; no messages sent.");
const originalFetch = globalThis.fetch;
let payload;
try {
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return Response.json({ messages: [{ id: "wamid-test" }] });
  };
  const { MetaWhatsAppProvider } = tsLoader({
    "@/lib/meta-access-token.server": { loadMetaAccessToken: async () => "fake-test-token" },
    "@/lib/crypto/token-crypto.server": {},
    "@/lib/pg.server": {},
  })("src/lib/whatsapp/providers/meta-whatsapp-provider.server.ts");
  const result = await new MetaWhatsAppProvider().sendText(
    { id: "channel", companyId: "company", phoneNumberId: "123" },
    "5511999999999",
    "Olá",
    choices,
  );
  assert.equal(result.ok, true);
  assert.equal(payload.type, "interactive");
  assert.equal(payload.interactive.action.buttons.length, 2);
  console.log(
    "PASS: actual Meta provider builds interactive Graph request using a fake HTTP transport.",
  );
} finally {
  globalThis.fetch = originalFetch;
}
