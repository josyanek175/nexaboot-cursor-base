import assert from "node:assert/strict";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
try {
  const load = tsLoader({
    "@/lib/pg.server": { getSql: () => db, sql: db },
    "@/lib/company.server": {},
    "@/lib/session.server": { getSessionUserId: () => null },
  });
  const ops = load("src/lib/company-operations.server.ts");
  const [{ id: company }] = await db`INSERT INTO companies(name) VALUES('Empresa A') RETURNING id`;
  const [{ id: other }] = await db`INSERT INTO companies(name) VALUES('Empresa B') RETURNING id`;
  const [{ id: channel }] =
    await db`INSERT INTO whatsapp_channels(company_id,name) VALUES(${company}::uuid,'Número A') RETURNING id`;
  const [{ id: user }] =
    await db`INSERT INTO users(company_id,name,role) VALUES(${company}::uuid,'Atendente','ATENDENTE') RETURNING id`;
  async function conversation(companyId = company) {
    const [{ id: contact }] =
      await db`INSERT INTO contacts(company_id,name) VALUES(${companyId}::uuid,'Cliente') RETURNING id`;
    const [conv] =
      await db`INSERT INTO conversations(company_id,contact_id,whatsapp_channel_id,status) VALUES(${companyId}::uuid,${contact}::uuid,${channel}::uuid,'open') RETURNING id`;
    return conv.id;
  }
  async function message(conv, direction, age, options = {}) {
    return db`INSERT INTO messages(conversation_id,direction,message_type,raw_payload,sent_by_user_id,created_at)
    VALUES(${conv}::uuid,${direction},'text',${JSON.stringify(options.payload ?? {})}::jsonb,${options.human ? user : null}::uuid,now()-make_interval(mins=>${age}))`;
  }
  const waiting = await conversation();
  await message(waiting, "in", 15);
  await message(waiting, "in", 1);
  const outside = await conversation(other);
  await message(outside, "in", 60);
  assert.equal((await ops.getAttendanceAlerts(company, user, true)).length, 1);
  assert.equal((await ops.getAttendanceAlerts(company, user, false)).length, 0);
  await db`INSERT INTO conversation_assignments(conversation_id,user_id) VALUES(${waiting}::uuid,${user}::uuid)`;
  assert.equal((await ops.getAttendanceAlerts(company, user, false))[0].id, waiting);
  await message(waiting, "out", 0, { human: true });
  assert.equal((await ops.getAttendanceAlerts(company, user, true)).length, 0);
  const waitingCustomer = await conversation();
  await message(waitingCustomer, "out", 1500, { human: true });
  assert.equal((await ops.getAttendanceAlerts(company, user, true))[0].waiting_for, "customer");
  const campaign = await conversation();
  await message(campaign, "out", 1500, { payload: { origin: "CAMPANHA" } });
  const answered = await conversation();
  await message(answered, "out", 1500, { payload: { origin: "CAMPANHA" } });
  await message(answered, "in", 1499);
  const taken = await conversation();
  await message(taken, "out", 1500, { payload: { origin: "CAMPANHA" } });
  await message(taken, "out", 1499, { human: true });
  const assigned = await conversation();
  await message(assigned, "out", 1500, { payload: { origin: "CAMPANHA" } });
  await db`INSERT INTO conversation_assignments(conversation_id,user_id,active,unassigned_at) VALUES(${assigned}::uuid,${user}::uuid,false,now())`;
  const fresh = await conversation();
  await message(fresh, "out", 1439, { payload: { origin: "CAMPANHA" } });
  assert.equal(await ops.expireUnansweredCampaigns(db), 1);
  assert.equal(await ops.expireUnansweredCampaigns(db), 0);
  for (const id of [answered, taken, assigned, fresh, waitingCustomer])
    assert.equal(
      (await db`SELECT status FROM conversations WHERE id=${id}::uuid`)[0].status,
      "open",
    );
  assert.equal(
    (await db`SELECT status FROM conversations WHERE id=${campaign}::uuid`)[0].status,
    "finished",
  );
  // Real lifecycle path: inbound after finished reopens the same conversation.
  const crm = load("src/lib/crm-inbound.server.ts");
  const [old] = await db`SELECT contact_id FROM conversations WHERE id=${campaign}::uuid`;
  const reopened = await crm.upsertInboundConversation({
    sql: db,
    companyId: company,
    channelId: channel,
    contactId: old.contact_id,
    newCycle: true,
  });
  assert.equal(reopened, campaign);
  assert.equal(
    (await db`SELECT status FROM conversations WHERE id=${campaign}::uuid`)[0].status,
    "open",
  );
  // Reopening also works with legacy uniqueness and resets the automation session.
  await db`UPDATE conversations SET status='finished' WHERE id=${reopened}::uuid`;
  await pg.exec(
    "CREATE UNIQUE INDEX legacy_tuple ON conversations(company_id,contact_id,whatsapp_channel_id)",
  );
  await db`INSERT INTO automation_sessions(conversation_id,company_id,status,collected) VALUES(${campaign}::uuid,${company}::uuid,'ended','{"old":true}')`;
  let restarted = false;
  assert.equal(
    await crm.upsertInboundConversation({
      sql: db,
      companyId: company,
      channelId: channel,
      contactId: old.contact_id,
      newCycle: true,
      onCycleReopened: () => {
        restarted = true;
      },
    }),
    campaign,
  );
  assert.equal(restarted, true);
  const [session] =
    await db`SELECT status,collected,step_id FROM automation_sessions WHERE conversation_id=${campaign}::uuid`;
  assert.equal(session.status, "ready");
  assert.deepEqual(session.collected, {});
  assert.equal(session.step_id, null);
  console.log(
    "PASS: isolated PostgreSQL — alert clocks/company scope; unanswered campaign expiry, human/reply protections, idempotence and conversation reopening with modern/legacy indexes.",
  );
} finally {
  await pg.close();
}
