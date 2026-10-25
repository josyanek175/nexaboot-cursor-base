import assert from "node:assert/strict";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
let sends = 0;
const sent = [];
try {
  const load = tsLoader({
    "@/lib/pg.server": { getSql: () => db, sql: db },
    "@/lib/company.server": {},
    "@/lib/session.server": { getSessionUserId: () => null },
    "@/lib/meta-send-message.server": {},
    "@/lib/meta-message-templates.server": {},
    "@/lib/message-send-router.server": {
      sendConversationText: async (p) => {
        sends++;
        sent.push(p);
        await db`INSERT INTO messages(conversation_id,direction,message_type,message_text,sent_by_name,raw_payload)
        VALUES(${p.conversationId}::uuid,'out','text',${p.text},'Fluxo',${JSON.stringify(p.automationKey ? { __nexaFlowSendKey: p.automationKey } : {})}::jsonb)`;
        return { ok: true, provider: "meta", message: {} };
      },
    },
  });
  const flow = load("src/lib/automation-flow.server.ts");
  const crm = load("src/lib/crm-inbound.server.ts");
  const lifecycle = load("src/lib/campaign-service-status.server.ts");
  await flow.ensureAutomationSchema();
  const [{ id: company }] = await db`INSERT INTO companies(name) VALUES('Empresa') RETURNING id`;
  const [{ id: channel }] =
    await db`INSERT INTO whatsapp_channels(company_id,name) VALUES(${company}::uuid,'Canal') RETURNING id`;
  const [{ id: contact }] =
    await db`INSERT INTO contacts(company_id,name,name_source,phone) VALUES(${company}::uuid,'Maria','manual','5511999999999') RETURNING id`;
  const definition = {
    entryStepId: "hello",
    steps: [
      { id: "hello", type: "message", text: "Olá {{nome}}", next: "options" },
      {
        id: "options",
        type: "buttons",
        text: "Como podemos ajudar?",
        buttons: [{ id: "support", label: "Suporte", next: "transfer" }],
      },
      { id: "transfer", type: "transfer", text: "Aguarde o atendente." },
    ],
  };
  const [{ id: id }] =
    await db`INSERT INTO automation_flows(company_id,name,kind,status,definition) VALUES(${company}::uuid,'Boas-vindas','attendance','active',${JSON.stringify(definition)}::jsonb) RETURNING id`;
  await db`INSERT INTO automation_flow_channels(company_id,channel_id,flow_id) VALUES(${company}::uuid,${channel}::uuid,${id}::uuid)`;
  let conversation = await crm.upsertInboundConversation({
    sql: db,
    companyId: company,
    channelId: channel,
    contactId: contact,
    newCycle: true,
  });
  const inbound = (text, extra = {}) =>
    flow.onAutomationInbound({
      companyId: company,
      channelId: channel,
      contactId: contact,
      conversationId: conversation,
      text,
      throwErrors: true,
      ...extra,
    });
  await inbound("Oi");
  assert.equal(sends, 2);
  assert.equal(sent[0].text, "Olá");
  assert.equal(sent[1].replyButtons[0].id, "support");
  await inbound("", { isMedia: true });
  assert.equal(sends, 2);
  await inbound("support");
  assert.equal(sends, 3);
  await inbound("Oi de novo");
  assert.equal(sends, 3, "Transferred conversations must not restart bot");
  await lifecycle.onCampaignFinish({ companyId: company, conversationId: conversation });
  const closed = conversation;
  conversation = await crm.upsertInboundConversation({
    sql: db,
    companyId: company,
    channelId: channel,
    contactId: contact,
    newCycle: true,
  });
  assert.notEqual(conversation, closed);
  await inbound("Voltei");
  assert.equal(sends, 5);
  assert.equal(sent[3].text, "Olá");
  assert.equal(
    (await db`SELECT count(*) AS n FROM messages WHERE conversation_id=${closed}::uuid`)[0].n,
    3,
  );
  await db`INSERT INTO conversation_assignments(conversation_id,user_id) VALUES(${conversation}::uuid,gen_random_uuid())`;
  await inbound("support");
  assert.equal(sends, 5, "Active human assignment must stop automation");
  console.log(
    "PASS: isolated PostgreSQL — real flow engine, Meta button choices, media wait, human handoff, finish/new greeting and preserved history. No Graph requests.",
  );
} finally {
  await pg.close();
}
