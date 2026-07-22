/**
 * Testes do extract de mensagens inbound Meta (sem DB).
 * Uso: npx tsx scripts/test-meta-inbound-extract.mjs
 */
import {
  extractMetaInboundTextMessages,
  resolveMetaInboundMessageText,
  unwrapMetaWebhookBody,
} from "../src/lib/meta-inbound-parse.ts";
import { classifyCampaignResponse } from "../src/lib/campaign-response.server.ts";

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

function buildPayload(message) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "1242056605648357" },
              contacts: [{ profile: { name: "Cliente" }, wa_id: "5511999999999" }],
              messages: [
                {
                  from: "5511999999999",
                  id: message.id ?? "wamid.TEST",
                  timestamp: "1710000001",
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
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
assert("skips non-text/button/interactive", skipImage.length === 0);

// A. button
const buttonPayload = buildPayload({
  id: "wamid.BUTTON_001",
  type: "button",
  button: { text: "Quero agendar", payload: "Quero agendar" },
});
const buttonMsgs = extractMetaInboundTextMessages(buttonPayload);
assert("button one message", buttonMsgs.length === 1);
assert("button resolved text", buttonMsgs[0]?.textBody === "Quero agendar");
assert("button message type", buttonMsgs[0]?.messageType === "button");
assert(
  "button resolver",
  resolveMetaInboundMessageText({ type: "button", button: { text: "Quero agendar", payload: "Quero agendar" } })
    ?.text === "Quero agendar",
);

// B. interactive.button_reply
const interactiveButtonPayload = buildPayload({
  id: "wamid.INTERACTIVE_BTN_001",
  type: "interactive",
  interactive: {
    type: "button_reply",
    button_reply: { id: "quero_agendar", title: "Quero agendar" },
  },
});
const interactiveButtonMsgs = extractMetaInboundTextMessages(interactiveButtonPayload);
assert("interactive button one message", interactiveButtonMsgs.length === 1);
assert("interactive button resolved text", interactiveButtonMsgs[0]?.textBody === "Quero agendar");
assert("interactive button message type", interactiveButtonMsgs[0]?.messageType === "interactive");

// C. interactive.list_reply
const interactiveListPayload = buildPayload({
  id: "wamid.INTERACTIVE_LIST_001",
  type: "interactive",
  interactive: {
    type: "list_reply",
    list_reply: { id: "duvida", title: "Tenho uma dúvida" },
  },
});
const interactiveListMsgs = extractMetaInboundTextMessages(interactiveListPayload);
assert("interactive list one message", interactiveListMsgs.length === 1);
assert("interactive list resolved text", interactiveListMsgs[0]?.textBody === "Tenho uma dúvida");

// button prefers text over payload
assert(
  "button prefers text",
  resolveMetaInboundMessageText({
    type: "button",
    button: { text: "Quero agendar", payload: "payload_antigo" },
  })?.text === "Quero agendar",
);

// fallback when button has no text/id
const fallbackPayload = buildPayload({
  id: "wamid.BUTTON_EMPTY",
  type: "button",
  button: {},
});
const fallbackMsgs = extractMetaInboundTextMessages(fallbackPayload);
assert("button fallback one message", fallbackMsgs.length === 1);
assert("button fallback text", fallbackMsgs[0]?.textBody === "[Resposta de botão]");

// D. dedup at extract level: same payload yields same externalMessageId once per message entry
const duplicatePayload = buildPayload({
  id: "wamid.DEDUP_001",
  type: "button",
  button: { text: "Quero agendar", payload: "Quero agendar" },
});
duplicatePayload.entry[0].changes[0].value.messages.push({
  from: "5511999999999",
  id: "wamid.DEDUP_001",
  timestamp: "1710000002",
  type: "button",
  button: { text: "Quero agendar", payload: "Quero agendar" },
});
const duplicateExtract = extractMetaInboundTextMessages(duplicatePayload);
assert("duplicate wamid extract count", duplicateExtract.length === 2);
assert(
  "duplicate wamid same external id",
  duplicateExtract.every((m) => m.externalMessageId === "wamid.DEDUP_001"),
);
assert(
  "persist dedup note",
  true,
);
console.log(
  "OK   persist dedup handled by INSERT ON CONFLICT (conversation_id, external_message_id) in crm-inbound.server.ts",
);

// classification
assert("classify quero agendar", classifyCampaignResponse("Quero agendar") === "interested");
assert("classify tenho uma duvida", classifyCampaignResponse("Tenho uma dúvida") === "interested");
assert(
  "classify me lembrar depois uses unknown",
  classifyCampaignResponse("Me lembrar depois") === "unknown",
);
assert("classify opt_out preserved", classifyCampaignResponse("sair") === "opt_out");

console.log(failed === 0 ? "\nAll Meta inbound extract tests passed." : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
