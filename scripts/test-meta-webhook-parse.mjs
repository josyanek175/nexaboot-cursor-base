/**
 * Testes manuais do parse de telefones no webhook Meta.
 * Uso: node scripts/test-meta-webhook-parse.mjs
 */
import {
  parseMetaPhoneField,
  parseMetaWebhookPhones,
  buildMetaWebhookAuditPayload,
} from "../src/lib/meta-webhook-parse.ts";

const usPayload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "+1 555 603-4558",
              phone_number_id: "123456789012345",
            },
            contacts: [{ profile: { name: "Test User" }, wa_id: "15556034558" }],
            messages: [
              {
                from: "15556034558",
                id: "wamid.US",
                timestamp: "1710000000",
                type: "text",
                text: { body: "hello" },
              },
            ],
          },
        },
      ],
    },
  ],
};

const brPayload = {
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            metadata: {
              display_phone_number: "+55 34 99970-8837",
              phone_number_id: "987654321098765",
            },
            contacts: [{ wa_id: "5534999708837", profile: { name: "João" } }],
            messages: [{ from: "5534999708837", id: "wamid.BR", type: "text" }],
          },
        },
      ],
    },
  ],
};

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

const usDisplay = parseMetaPhoneField("+1 555 603-4558");
assert("display +1 555 603-4558 e164", usDisplay?.e164 === "15556034558");
assert("display +1 555 603-4558 valid", usDisplay?.valid === true);
assert("display +1 555 603-4558 formatted", usDisplay?.display === "+1 555 603-4558");

const usFrom = parseMetaPhoneField("15556034558");
assert("messages.from US e164", usFrom?.e164 === "15556034558");
assert("messages.from US valid", usFrom?.valid === true);

const ptWaId = parseMetaPhoneField("351912345678");
assert("wa_id PT e164", ptWaId?.e164 === "351912345678");
assert("wa_id PT valid", ptWaId?.valid === true);

const usParsed = parseMetaWebhookPhones(usPayload);
assert("US payload one change", usParsed.length === 1);
assert("US phone_number_id", usParsed[0]?.phone_number_id === "123456789012345");
assert(
  "US display_phone_number",
  usParsed[0]?.display_phone_number?.e164 === "15556034558",
);
assert("US contact wa_id", usParsed[0]?.contacts[0]?.wa_id?.e164 === "15556034558");
assert("US message from", usParsed[0]?.messages[0]?.from?.e164 === "15556034558");
assert("US contact name", usParsed[0]?.contacts[0]?.name === "Test User");

const brParsed = parseMetaWebhookPhones(brPayload);
assert("BR display e164", brParsed[0]?.display_phone_number?.e164 === "5534999708837");
assert("BR message from", brParsed[0]?.messages[0]?.from?.e164 === "5534999708837");

const audit = buildMetaWebhookAuditPayload(usPayload, usParsed);
assert("audit has body", audit.body != null);
assert("audit has parsed_phones", Array.isArray(audit.parsed_phones));

const sensitivePayload = {
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "1", display_phone_number: "+1 555 603-4558" },
            access_token: "secret-token",
          },
        },
      ],
    },
  ],
};
const sensitiveAudit = buildMetaWebhookAuditPayload(sensitivePayload, parseMetaWebhookPhones(sensitivePayload));
const bodyJson = JSON.stringify(sensitiveAudit.body);
assert("audit redacts access_token", bodyJson.includes("[redacted]") && !bodyJson.includes("secret-token"));

console.log(failed === 0 ? "\nAll Meta webhook parse tests passed." : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
