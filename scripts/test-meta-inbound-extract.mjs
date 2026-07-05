/**
 * Testes do extract de mensagens texto inbound Meta (sem DB).
 * Uso: node scripts/test-meta-inbound-extract.mjs
 */
import {
  extractMetaInboundTextMessages,
  unwrapMetaWebhookBody,
} from "../src/lib/meta-inbound-parse.ts";

const directPayload = {
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            metadata: {
              phone_number_id: "1255731454280186",
              display_phone_number: "+1 555 603-4558",
            },
            contacts: [{ profile: { name: "Test User" }, wa_id: "15556034558" }],
            messages: [
              {
                from: "15556034558",
                id: "wamid.DEV_TEST_004",
                timestamp: "1710000000",
                type: "text",
                text: { body: "hello dev 004" },
              },
            ],
          },
        },
      ],
    },
  ],
};

const auditWrapperPayload = {
  body: directPayload,
  parsed_phones: [{ phone_number_id: "1255731454280186" }],
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

function assertMessage(msg, labelPrefix) {
  assert(`${labelPrefix} one text message`, msg.length === 1);
  assert(`${labelPrefix} phone_number_id`, msg[0]?.phoneNumberId === "1255731454280186");
  assert(`${labelPrefix} phone e164`, msg[0]?.phone === "15556034558");
  assert(`${labelPrefix} contact name`, msg[0]?.contactName === "Test User");
  assert(`${labelPrefix} text body`, msg[0]?.textBody === "hello dev 004");
  assert(`${labelPrefix} wamid`, msg[0]?.externalMessageId === "wamid.DEV_TEST_004");
  assert(`${labelPrefix} raw payload sanitized`, msg[0]?.rawPayload?.message != null);
}

assertMessage(extractMetaInboundTextMessages(directPayload), "direct");

const unwrapped = unwrapMetaWebhookBody(auditWrapperPayload);
assert("unwrap audit wrapper", unwrapped?.entry != null);
assertMessage(extractMetaInboundTextMessages(auditWrapperPayload), "wrapper");

const skipImage = extractMetaInboundTextMessages({
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "1" },
            messages: [{ from: "15556034558", id: "w1", type: "image" }],
          },
        },
      ],
    },
  ],
});
assert("skips non-text", skipImage.length === 0);

console.log(failed === 0 ? "\nAll Meta inbound extract tests passed." : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
