import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
try {
  await pg.exec(`
    ALTER TABLE users ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN avatar_url text,ADD COLUMN last_login_at timestamptz;
    ALTER TABLE messages ADD COLUMN external_id text,ADD COLUMN media_base64 text,ADD COLUMN media_url text,ADD COLUMN media_error text,ADD COLUMN mime_type text,ADD COLUMN media_mimetype text,ADD COLUMN media_filename text,ADD COLUMN media_type text,ADD COLUMN media_size integer,ADD COLUMN media_seconds integer,ADD COLUMN media_caption text,ADD COLUMN reaction_emoji text,ADD COLUMN reaction_to_message_id text;
    CREATE TABLE plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,code text,max_whatsapp_channels integer,max_users integer,active boolean DEFAULT true);
    CREATE TABLE company_subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id),plan_id uuid REFERENCES plans(id),status text DEFAULT 'active',started_at timestamptz DEFAULT now(),ends_at timestamptz);
  `);
  const [{ id: a }] = await db`INSERT INTO companies(name) VALUES('A') RETURNING id`;
  const [{ id: b }] = await db`INSERT INTO companies(name) VALUES('B') RETURNING id`;
  const oldHash = await bcrypt.hash("before-password", 4);
  const [{ id: admin }] =
    await db`INSERT INTO users(company_id,name,email,role,password_hash) VALUES(${a}::uuid,'Admin A','a@example.test','ADMIN_EMPRESA',${oldHash}) RETURNING id`;
  const [{ id: other }] =
    await db`INSERT INTO users(company_id,name,email,role,password_hash) VALUES(${b}::uuid,'Admin B','b@example.test','ADMIN_EMPRESA',${oldHash}) RETURNING id`;
  const [{ id: ti }] =
    await db`INSERT INTO users(name,email,role) VALUES('TI','ti@example.test','TI') RETURNING id`;
  const [{ id: owner }] =
    await db`INSERT INTO users(name,email,role) VALUES('Owner','owner@example.test','SUPER_ADMIN') RETURNING id`;
  const [{ id: x }] =
    await db`INSERT INTO whatsapp_channels(company_id,name) VALUES(${a}::uuid,'A') RETURNING id`;
  const [{ id: y }] =
    await db`INSERT INTO whatsapp_channels(company_id,name) VALUES(${b}::uuid,'B') RETURNING id`;
  const [{ id: ca }] =
    await db`INSERT INTO contacts(company_id,name) VALUES(${a}::uuid,'Cliente A') RETURNING id`;
  const [{ id: cb }] =
    await db`INSERT INTO contacts(company_id,name) VALUES(${b}::uuid,'Cliente B') RETURNING id`;
  const [{ id: va }] =
    await db`INSERT INTO conversations(company_id,contact_id,whatsapp_channel_id,status) VALUES(${a}::uuid,${ca}::uuid,${x}::uuid,'open') RETURNING id`;
  const [{ id: vb }] =
    await db`INSERT INTO conversations(company_id,contact_id,whatsapp_channel_id,status) VALUES(${b}::uuid,${cb}::uuid,${y}::uuid,'open') RETURNING id`;
  const [{ id: ma }] =
    await db`INSERT INTO messages(conversation_id,direction,message_type,message_text,media_base64,mime_type) VALUES(${va}::uuid,'in','image','A','AQID','image/png') RETURNING id`;
  const [{ id: mb }] =
    await db`INSERT INTO messages(conversation_id,direction,message_type,message_text,media_base64,mime_type) VALUES(${vb}::uuid,'in','image','B','AQID','image/png') RETURNING id`;
  let uid = admin,
    selected = b,
    sends = 0;
  const load = tsLoader({
    "@tanstack/react-router": { createFileRoute: () => (config) => config },
    "@/lib/pg.server": { sql: db, getSql: () => db },
    "@/lib/session.server": { getSessionUserId: () => uid },
    "@/lib/operational-company.server": { getOperationalCompanyIdFromCookie: () => selected },
    "@/lib/perf-diag.server": {
      withApiTiming: async (_opts, fn) =>
        fn({ timedDb: async (_label, f) => f(), setResultCount: () => {} }),
    },
    "@/lib/meta-media-download.server": {},
    "@/lib/whatsapp/whatsapp-provider-router.server": {},
    "@/lib/message-send-router.server": {
      sendConversationText: async () => {
        sends++;
        return { ok: true, provider: "meta", message: {} };
      },
    },
  });
  const company = load("src/lib/company.server.ts");
  assert.equal(
    (await company.getCurrentUserCompanyInfo()).companyId,
    a,
    "Company admin ignores platform selection",
  );
  const users = load("src/routes/api/users.ts").Route.server.handlers;
  assert.deepEqual(
    (await (await users.GET()).json()).users.map((u) => u.id),
    [admin],
  );
  const user = load("src/routes/api/users/$id.ts").Route.server.handlers;
  const reset = await user.PUT({
    params: { id: other },
    request: new Request("https://example.test/api/users/" + other, {
      method: "PUT",
      body: JSON.stringify({ password: "forbidden-reset" }),
    }),
  });
  assert.equal(reset.status, 404);
  assert.equal(
    (await db`SELECT password_hash FROM users WHERE id=${other}::uuid`)[0].password_hash,
    oldHash,
  );
  const contacts = load("src/routes/api/contacts/$id.ts").Route.server.handlers;
  assert.equal(
    (
      await contacts.PUT({
        params: { id: cb },
        request: new Request("https://example.test/api/contacts/" + cb, {
          method: "PUT",
          body: JSON.stringify({ name: "forbidden" }),
        }),
      })
    ).status,
    404,
  );
  const messages = load("src/routes/api/conversations/$id/messages.ts").Route.server.handlers;
  assert.equal(
    (
      await messages.GET({
        params: { id: vb },
        request: new Request("https://example.test/api/conversations/" + vb + "/messages"),
      })
    ).status,
    404,
  );
  const visible = await (
    await messages.GET({
      params: { id: va },
      request: new Request("https://example.test/api/conversations/" + va + "/messages"),
    })
  ).json();
  assert.deepEqual(
    visible.messages.map((m) => m.id),
    [ma],
  );
  const media = load("src/routes/api/messages/$messageId/media.ts").Route.server.handlers;
  assert.equal((await media.GET({ params: { messageId: mb } })).status, 404);
  assert.equal((await media.GET({ params: { messageId: ma } })).status, 200);
  const sender = load("src/routes/api/messages/send.ts").Route.server.handlers;
  const send = (id) =>
    sender.POST({
      request: new Request("https://example.test/api/messages/send", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "test" }),
      }),
    });
  assert.equal((await send(vb)).status, 404);
  assert.equal(sends, 0);
  await db`UPDATE users SET role='ATENDENTE' WHERE id=${admin}::uuid`;
  await db`INSERT INTO company_operations_settings(company_id,restrict_channels) VALUES(${a}::uuid,true)`;
  assert.equal((await send(va)).status, 403);
  assert.equal((await media.GET({ params: { messageId: ma } })).status, 403);
  assert.equal(sends, 0);
  await db`INSERT INTO company_channel_grants(company_id,channel_id,user_id) VALUES(${a}::uuid,${x}::uuid,${admin}::uuid)`;
  assert.equal((await send(va)).status, 200);
  assert.equal(sends, 1);
  uid = ti;
  assert.equal((await company.getCurrentUserCompanyInfo()).companyId, b);
  assert.deepEqual(
    (await (await users.GET()).json()).users.map((u) => u.id),
    [other],
  );
  selected = a;
  assert.equal((await company.getCurrentUserCompanyInfo()).companyId, a);
  await db`UPDATE companies SET active=false WHERE id=${a}::uuid`;
  assert.equal((await company.requireCompanyId()).status, 403);
  await db`UPDATE companies SET active=true WHERE id=${a}::uuid`;
  const companies = load("src/routes/api/companies.ts").Route.server.handlers;
  const [{ id: plan }] =
    await db`INSERT INTO plans(name,code,max_whatsapp_channels) VALUES('Teste','teste',2) RETURNING id`;
  uid = owner;
  const response = await companies.POST({
    request: new Request("https://example.test/api/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "Nova",
        plan_id: plan,
        admin: { name: "Novo admin", email: "new@example.test", password: "new-admin-password" },
      }),
    }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  const [newAdmin] =
    await db`SELECT role,company_id,password_hash FROM users WHERE id=${created.admin_user_id}::uuid`;
  assert.equal(newAdmin.company_id, created.company.id);
  assert.equal(newAdmin.role, "ADMIN_EMPRESA");
  assert.equal(await bcrypt.compare("new-admin-password", newAdmin.password_hash), true);
  const listed = await (await companies.GET()).json();
  assert.equal(listed.companies.length, 3);
  console.log(
    "PASS: isolated PostgreSQL + actual API handlers — two companies, users/password reset, contacts, message history, media, blocked sends, channel grants, TI switching, inactive company and SUPER_ADMIN provisioning. No outbound provider called.",
  );
} finally {
  await pg.close();
}
