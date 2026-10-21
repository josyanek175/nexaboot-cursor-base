/** Integration: real PostgreSQL, simulated provider only. Requires a disposable DB.
 * ATTENDANCE_TEST_DATABASE_URL=postgres://attendance_test@127.0.0.1:55473/attendance_lifecycle_test
 * Refuses non-loopback hosts and databases whose names do not end in _test.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import postgres from "postgres";
import { readFileSync } from "node:fs";

const url = process.env.ATTENDANCE_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "Set ATTENDANCE_TEST_DATABASE_URL to a disposable local database ending in _test",
  );
const parsed = new URL(url);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
assert.match(parsed.pathname, /_test$/);
const db = postgres(url, { max: 8, onnotice() {} });
const state = { db, sent: [], failNext: false };
globalThis.__attendanceTest = state;
const mocks = {
  "pg.server": `export const getSql = () => globalThis.__attendanceTest.db;
    export function sql(strings, ...values) { const db = getSql(); return strings ? db(strings, ...values) : db; }`,
  "company.server":
    'export const getCurrentUserCompanyInfo = () => null; export const requireCompanyId = () => { throw new Error("unexpected auth"); };',
  "session.server": "export const getSessionUserId = () => null;",
  "message-send-router.server": `export async function sendConversationText(p) {
    const state = globalThis.__attendanceTest;
    if (state.failNext) { state.failNext = false; return {ok:false, error:'simulated_failure'}; }
    await state.db\`INSERT INTO public.messages (conversation_id, direction, message_type, message_text, from_me, status, sent_by_name)
      VALUES (\${p.conversationId}::uuid, 'out', 'text', \${p.text}, true, 'sent', 'Fluxo')\`;
    state.sent.push(p); return {ok:true};
  }`,
  "meta-send-message.server":
    'export const sendMetaTemplateMessage = () => { throw new Error("unexpected provider"); };',
  "meta-message-templates.server": "export const toMetaTemplatePublic = () => ({});",
};
const result = await build({
  stdin: {
    contents: `export * from './src/lib/attendance-inbound.server';
    export * from './src/lib/attendance-jobs.server';
    export * from './src/lib/automation-flow.server';
    export * from './src/lib/attendance-lifecycle';
    export * from './src/lib/automation-flow';
    export { onCampaignFinish } from './src/lib/campaign-service-status.server';`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  tsconfig: "tsconfig.json",
  plugins: [
    {
      name: "isolated-services",
      setup(builder) {
        builder.onResolve({ filter: /^@\/lib\// }, (args) => {
          const name = args.path.slice("@/lib/".length);
          if (name in mocks) return { path: name, namespace: "mock" };
        });
        builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
          contents: mocks[args.path],
          loader: "js",
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const api = module.exports;
let checks = 0;
async function scenario(name, fn) {
  await fn();
  checks++;
  console.log(`PASS ${checks}: ${name}`);
}
async function count(table, conversationId) {
  return Number(
    (
      await db.unsafe(`SELECT count(*) AS n FROM public.${table} WHERE conversation_id = $1`, [
        conversationId,
      ])
    )[0].n,
  );
}
const companyId = randomUUID(),
  channelId = randomUUID();
const input = (id, extra = {}) => ({
  companyId,
  channelId,
  phone: "5511998765432",
  profileName: "Maria",
  externalMessageId: id,
  text: "Oi",
  rawPayload: {},
  ...extra,
});
async function makeFlow(company, channel, greeting) {
  const id = randomUUID();
  const definition = {
    entryStepId: "welcome",
    steps: [
      {
        id: "welcome",
        type: "buttons",
        text: greeting,
        buttons: [{ id: "1", label: "Ajuda", next: "end" }],
      },
      { id: "end", type: "end", text: "Até logo" },
    ],
  };
  await db`INSERT INTO public.automation_flows (id,company_id,name,kind,status,definition)
    VALUES (${id},${company},'Atendimento','attendance','active',${db.json(definition)})`;
  await db`INSERT INTO public.automation_flow_channels (flow_id,channel_id,company_id) VALUES (${id},${channel},${company})`;
}
try {
  await db.unsafe(`
    CREATE TABLE contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
      phone text, phone_match text, name text, name_source text, status text, reference text,
      external_jid text, contact_type text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX contacts_active ON contacts(company_id,phone_match)
      WHERE status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo';
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, contact_id uuid REFERENCES contacts,
      whatsapp_channel_id uuid, status text, unread_count int DEFAULT 0,last_message text,last_message_at timestamptz,
      campaign_reply_campaign_id uuid,campaign_service_status text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES conversations,
      external_id text,external_message_id text,direction text,message_type text,message_text text,from_me boolean,
      raw_payload jsonb,status text,sent_by_name text,media_type text,media_mimetype text,mime_type text,
      media_filename text,media_caption text,media_base64 text,media_error text,media_url text,media_size bigint,
      created_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX messages_conv_extid_uniq ON messages(conversation_id,external_message_id) WHERE external_message_id IS NOT NULL;
    CREATE TABLE conversation_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,
      user_id uuid,active boolean,unassigned_at timestamptz);
  `);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  assert.equal(await api.ensureAttendanceLifecycleSchema(), false);
  assert.equal(
    (
      await db`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contacts' AND column_name='whatsapp_profile_name'`
    )[0].n,
    0,
  );
  // Reproduce production incident: no profile column, no source column, no queue.
  const legacy = await api.commitMetaAttendanceMessage(
    input("legacy-1", { phone: "5511000000001" }),
  );
  assert.ok(legacy.messageId);
  await db`UPDATE contacts SET name='Cadastro confirmado', name_source='manual' WHERE id=${legacy.contactId}`;
  const legacyExisting = await api.commitMetaAttendanceMessage(
    input("legacy-2", { phone: "5511000000001", profileName: "Outro perfil" }),
  );
  assert.ok(legacyExisting.messageId);
  assert.equal(
    (await db`SELECT name FROM contacts WHERE id=${legacy.contactId}`)[0].name,
    "Cadastro confirmado",
  );
  const legacyEcho = await api.commitMetaAttendanceMessage(
    input("legacy-echo", { phone: "5511000000001", echo: true }),
  );
  assert.ok(legacyEcho.messageId);
  assert.equal(await api.drainAttendanceJobs(legacy.conversationId), 0);
  const legacyReplay = await api.commitMetaAttendanceMessage(
    input("legacy-1", { phone: "5511000000001" }),
  );
  assert.equal(legacyReplay.messageId, null);
  const legacyMedia = await api.commitMetaAttendanceMessage(
    input("legacy-media", {
      phone: "5511000000001",
      text: "[áudio]",
      media: {
        mediaType: "audio",
        messageText: "[áudio]",
        caption: null,
        mimeType: "audio/ogg",
        filename: null,
        mediaBase64: null,
        mediaError: null,
        mediaSize: null,
        rawPayload: {},
      },
    }),
  );
  assert.ok(legacyMedia.messageId);
  assert.equal(
    (await db`SELECT to_regclass('public.attendance_automation_jobs') AS name`)[0].name,
    null,
  );
  console.log(
    "PASS recovery: production without optional schema receives text, media and echoes; preserves manual names and deduplicates.",
  );
  // Recovery must not fail on the legacy active duplicates that can abort the original migration.
  await db`INSERT INTO conversations(company_id,contact_id,whatsapp_channel_id,status)
    VALUES (${companyId},${legacy.contactId},${channelId},'open')`;
  const failedMigrationConnection = await db.reserve();
  try {
    await assert.rejects(
      failedMigrationConnection.unsafe(
        readFileSync("scripts/migrations/20261020_attendance_lifecycle.sql", "utf8"),
      ),
      (error) => error.code === "23505",
    );
    await failedMigrationConnection.unsafe("ROLLBACK");
  } finally {
    failedMigrationConnection.release();
  }
  assert.equal(
    (
      await db`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contacts' AND column_name='whatsapp_profile_name'`
    )[0].n,
    0,
  );
  const afterFailedMigration = await api.commitMetaAttendanceMessage(
    input("after-failed-migration", { phone: "5511000000001" }),
  );
  assert.ok(afterFailedMigration.messageId);
  const recoveryConnection = await db.reserve();
  try {
    await recoveryConnection.unsafe(
      readFileSync("scripts/migrations/20261021_attendance_recovery.sql", "utf8"),
    );
    await recoveryConnection.unsafe(
      readFileSync("scripts/migrations/20261021_attendance_recovery.sql", "utf8"),
    );
  } finally {
    recoveryConnection.release();
  }
  const actualNow = Date.now;
  try {
    Date.now = () => actualNow() + 16000;
    assert.equal(await api.ensureAttendanceLifecycleSchema(), true);
  } finally {
    Date.now = actualNow;
  }
  assert.equal(
    (
      await db`SELECT count(*)::int AS n FROM messages WHERE conversation_id=${legacy.conversationId}`
    )[0].n,
    5,
  );
  await db`UPDATE conversations SET status='finished' WHERE contact_id=${legacy.contactId}`;
  console.log(
    "PASS recovery: additive migration applied twice despite legacy duplicates; schema readiness recovers without restarting.",
  );
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  await api.ensureAttendanceLifecycleSchema();
  await api.ensureAutomationSchema();
  await makeFlow(companyId, channelId, "Olá, {{nome}}!");
  let first, second;
  await scenario("perfil novo, saudação e não lidas", async () => {
    first = await api.commitMetaAttendanceMessage(input("one"));
    assert.equal(await count("attendance_automation_jobs", first.conversationId), 1);
    await api.drainAttendanceJobs(first.conversationId);
    assert.match(state.sent.at(-1).text, /Olá, Maria!/);
    assert.equal(
      (await db`SELECT unread_count FROM conversations WHERE id=${first.conversationId}`)[0]
        .unread_count,
      1,
    );
  });
  await scenario("nome cadastral preservado e prioritário", async () => {
    await db`UPDATE contacts SET name='Maria Confirmada', name_source='manual' WHERE id=${first.contactId}`;
    await api.commitMetaAttendanceMessage(input("two", { profileName: "Novo Perfil" }));
    const contact = (await db`SELECT * FROM contacts WHERE id=${first.contactId}`)[0];
    assert.equal(contact.name, "Maria Confirmada");
    assert.equal(contact.whatsapp_profile_name, "Novo Perfil");
    assert.equal(api.attendanceDisplayName(contact), "Maria Confirmada");
  });
  await scenario("alteração de perfil e valor vazio não apaga", async () => {
    await api.commitMetaAttendanceMessage(input("three", { profileName: "  Ana  " }));
    await api.commitMetaAttendanceMessage(input("four", { profileName: " \n " }));
    assert.equal(
      (await db`SELECT whatsapp_profile_name FROM contacts WHERE id=${first.contactId}`)[0]
        .whatsapp_profile_name,
      "Ana",
    );
    assert.equal(
      api.attendanceDisplayName({
        name: null,
        name_source: "auto",
        phone: "123",
        whatsapp_profile_name: "Ana",
      }),
      "Ana",
    );
    assert.equal(api.renderFlowText("Olá, {{nome}}!", { nome: "" }), "Olá!");
    assert.equal(api.validProfileName("\u0000 \n"), null);
  });
  await scenario("open e waiting preservam ciclo, sem repetir saudação", async () => {
    await db`UPDATE conversations SET status='waiting' WHERE id=${first.conversationId}`;
    const same = await api.commitMetaAttendanceMessage(input("five"));
    assert.equal(same.conversationId, first.conversationId);
    assert.equal(
      (await db`SELECT status FROM conversations WHERE id=${first.conversationId}`)[0].status,
      "waiting",
    );
    await api.drainAttendanceJobs(first.conversationId);
    assert.equal(
      state.sent.filter(
        (m) => m.conversationId === first.conversationId && m.text.startsWith("Olá"),
      ).length,
      1,
    );
    await api.commitMetaAttendanceMessage(input("choice", { text: "1" }));
    await api.drainAttendanceJobs(first.conversationId);
    assert.equal(
      (
        await db`SELECT status FROM automation_sessions WHERE conversation_id=${first.conversationId}`
      )[0].status,
      "ended",
    );
    const sentBefore = state.sent.length;
    await api.commitMetaAttendanceMessage(input("after-end"));
    await api.drainAttendanceJobs(first.conversationId);
    assert.equal(state.sent.length, sentBefore);
  });
  await scenario("encerramento libera humano e mantém histórico", async () => {
    await db`INSERT INTO conversation_assignments(conversation_id,user_id,active) VALUES (${first.conversationId},${randomUUID()},true)`;
    const before = await count("messages", first.conversationId);
    await api.onCampaignFinish({ companyId, conversationId: first.conversationId });
    assert.equal(
      (
        await db`SELECT active FROM conversation_assignments WHERE conversation_id=${first.conversationId}`
      )[0].active,
      false,
    );
    assert.equal(
      (
        await db`SELECT status FROM automation_sessions WHERE conversation_id=${first.conversationId}`
      )[0].status,
      "ended",
    );
    assert.equal(await count("messages", first.conversationId), before);
    second = await api.commitMetaAttendanceMessage(input("six"));
    assert.notEqual(second.conversationId, first.conversationId);
    assert.equal(
      (await db`SELECT status FROM conversations WHERE id=${first.conversationId}`)[0].status,
      "finished",
    );
    await api.drainAttendanceJobs(second.conversationId);
    assert.match(state.sent.at(-1).text, /Maria Confirmada/);
  });
  await scenario("replay entre ciclos não abre atendimento", async () => {
    await api.onCampaignFinish({ companyId, conversationId: second.conversationId });
    const replay = await api.commitMetaAttendanceMessage(input("one"));
    assert.equal(replay.messageId, null);
    assert.equal(replay.conversationId, first.conversationId);
    assert.equal(
      (await db`SELECT count(*)::int AS n FROM conversations WHERE status IN ('open','waiting')`)[0]
        .n,
      0,
    );
  });
  await scenario("concorrência: 12 mensagens, um ciclo e uma saudação", async () => {
    const rows = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api.commitMetaAttendanceMessage(
          input("parallel-" + i, { phone: i % 2 ? "551198765432" : "5511998765432" }),
        ),
      ),
    );
    assert.equal(new Set(rows.map((r) => r.conversationId)).size, 1);
    second = rows[0];
    await Promise.all(
      Array.from({ length: 4 }, () => api.drainAttendanceJobs(second.conversationId)),
    );
    assert.equal(await count("attendance_automation_jobs", second.conversationId), 12);
    await assert.rejects(
      db`INSERT INTO conversations(company_id,contact_id,whatsapp_channel_id,status)
      VALUES (${companyId},${second.contactId},${channelId},'open')`,
      (error) => error.code === "23505",
    );
    const duplicates = await Promise.all(
      Array.from({ length: 8 }, () =>
        api.commitMetaAttendanceMessage(input("same-concurrent", { phone: "5511333333333" })),
      ),
    );
    assert.equal(duplicates.filter((row) => row.messageId).length, 1);
    assert.equal(new Set(duplicates.map((row) => row.conversationId)).size, 1);
    assert.equal(
      state.sent.filter(
        (m) => m.conversationId === second.conversationId && m.text.startsWith("Olá"),
      ).length,
      1,
    );
  });
  await scenario("falha antes do commit desfaz contato, conversa e mensagem", async () => {
    const before = (await db`SELECT count(*)::int AS n FROM conversations`)[0].n;
    await assert.rejects(
      db.begin(async (tx) => {
        await api.persistMetaAttendanceMessage(tx, input("rollback", { phone: "5511888888888" }));
        throw new Error("rollback");
      }),
    );
    assert.equal((await db`SELECT count(*)::int AS n FROM conversations`)[0].n, before);
    assert.equal(
      (await db`SELECT count(*)::int AS n FROM messages WHERE external_message_id='rollback'`)[0].n,
      0,
    );
  });
  await scenario("falha de envio mantém tarefa para retry após commit", async () => {
    const failed = await api.commitMetaAttendanceMessage(
      input("failed", { phone: "5511777777777" }),
    );
    state.failNext = true;
    await api.drainAttendanceJobs(failed.conversationId);
    assert.equal(
      (
        await db`SELECT status FROM attendance_automation_jobs WHERE conversation_id=${failed.conversationId}`
      )[0].status,
      "retry",
    );
    await db`UPDATE attendance_automation_jobs SET available_at=now() WHERE conversation_id=${failed.conversationId}`;
    await api.drainAttendanceJobs(failed.conversationId);
    assert.equal(
      (
        await db`SELECT status FROM attendance_automation_jobs WHERE conversation_id=${failed.conversationId}`
      )[0].status,
      "processed",
    );
    assert.equal(state.sent.filter((m) => m.conversationId === failed.conversationId).length, 1);
    const abandoned = await api.commitMetaAttendanceMessage(
      input("abandoned", { phone: "5511222222222" }),
    );
    await db`UPDATE attendance_automation_jobs SET status='processing',lease_until=now()-interval '1 minute',
      claim_token=gen_random_uuid() WHERE conversation_id=${abandoned.conversationId}`;
    await api.drainAttendanceJobs(abandoned.conversationId);
    assert.equal(state.sent.filter((m) => m.conversationId === abandoned.conversationId).length, 1);
  });
  await scenario("primeira mensagem de mídia inicia boas-vindas", async () => {
    const media = await api.commitMetaAttendanceMessage(
      input("media", {
        phone: "5511666666666",
        text: "[áudio]",
        media: {
          mediaType: "audio",
          messageText: "[áudio]",
          caption: null,
          mimeType: "audio/ogg",
          filename: null,
          mediaBase64: null,
          mediaError: null,
          mediaSize: null,
          rawPayload: {},
        },
      }),
    );
    await api.drainAttendanceJobs(media.conversationId);
    assert.equal(state.sent.filter((m) => m.conversationId === media.conversationId).length, 1);
  });
  await scenario("atribuição humana impede bot, mesmo sem sessão", async () => {
    const human = await api.commitMetaAttendanceMessage(input("human", { phone: "5511555555555" }));
    await db`INSERT INTO conversation_assignments(conversation_id,user_id,active) VALUES (${human.conversationId},${randomUUID()},true)`;
    await api.drainAttendanceJobs(human.conversationId);
    assert.equal(state.sent.filter((m) => m.conversationId === human.conversationId).length, 0);
  });
  await scenario("tenant/canal isolados, echoes sem reabertura nem boas-vindas", async () => {
    const otherCompany = randomUUID(),
      otherChannel = randomUUID();
    await makeFlow(otherCompany, otherChannel, "Bem-vinda ao outro tenant, {{nome}}!");
    const other = await api.commitMetaAttendanceMessage(
      input("one", { companyId: otherCompany, channelId: otherChannel }),
    );
    await api.drainAttendanceJobs(other.conversationId);
    assert.match(state.sent.at(-1).text, /outro tenant/);
    assert.notEqual(other.contactId, first.contactId);
    const sameTenantChannel = randomUUID();
    await makeFlow(companyId, sameTenantChannel, "Outro canal {{nome}}");
    const sameTenant = await api.commitMetaAttendanceMessage(
      input("one", { channelId: sameTenantChannel }),
    );
    assert.notEqual(sameTenant.conversationId, first.conversationId);
    assert.equal(sameTenant.contactId, first.contactId);
    await api.drainAttendanceJobs(sameTenant.conversationId);
    assert.match(state.sent.at(-1).text, /Outro canal/);
    await api.onCampaignFinish({ companyId: otherCompany, conversationId: other.conversationId });
    const before = state.sent.length;
    const echo = await api.commitMetaAttendanceMessage(
      input("echo", {
        companyId: otherCompany,
        channelId: otherChannel,
        echo: true,
        profileName: null,
      }),
    );
    assert.equal(echo.conversationId, other.conversationId);
    assert.equal(
      (await db`SELECT status FROM conversations WHERE id=${other.conversationId}`)[0].status,
      "finished",
    );
    assert.equal(
      (
        await db`SELECT count(*)::int AS n FROM attendance_automation_jobs WHERE message_id=${echo.messageId}`
      )[0].n,
      0,
    );
    assert.equal(
      (await db`SELECT from_me,message_source FROM messages WHERE id=${echo.messageId}`)[0]
        .message_source,
      "whatsapp_business_app",
    );
    assert.equal(state.sent.length, before);
    const freshEcho = await api.commitMetaAttendanceMessage(
      input("fresh-echo", { phone: "5511444444444", echo: true }),
    );
    assert.equal(
      (
        await db`SELECT status,unread_count FROM conversations WHERE id=${freshEcho.conversationId}`
      )[0].unread_count,
      0,
    );
    const customer = await api.commitMetaAttendanceMessage(
      input("after-echo", { phone: "5511444444444" }),
    );
    assert.notEqual(customer.conversationId, freshEcho.conversationId);
  });
  // Execute the actual bootstrap dedup routine against multiple historical cycles.
  const pgSource = readFileSync("src/lib/pg.server.ts", "utf8");
  const dedupStart = pgSource.indexOf("async function ensureConversationsDedup");
  const dedupEnd = pgSource.indexOf("\n}", dedupStart) + 2;
  const dedupBundle = await build({
    stdin: {
      contents: `import {normalizePhoneForMatch} from './src/lib/phone'; ${pgSource.slice(dedupStart, dedupEnd)}; export {ensureConversationsDedup};`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const dedupModule = { exports: {} };
  new Function("require", "module", "exports", dedupBundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    dedupModule,
    dedupModule.exports,
  );
  const historicalBefore = await db`SELECT id,conversation_id FROM messages ORDER BY id`;
  await dedupModule.exports.ensureConversationsDedup(db);
  assert.deepEqual(await db`SELECT id,conversation_id FROM messages ORDER BY id`, historicalBefore);
  // Migration is repeatable and preserves historical cycle IDs and message links.
  const migrationConnection = await db.reserve();
  try {
    await migrationConnection.unsafe(
      readFileSync("scripts/migrations/20261020_attendance_lifecycle.sql", "utf8"),
    );
    await migrationConnection.unsafe(
      readFileSync("scripts/migrations/20261020_attendance_lifecycle.sql", "utf8"),
    );
  } finally {
    migrationConnection.release();
  }
  assert.equal(
    (await db`SELECT status FROM conversations WHERE id=${first.conversationId}`)[0].status,
    "finished",
  );
  console.log(
    `${checks}/12 scenarios passed; migration reapplied twice; bootstrap preserved history.`,
  );
} finally {
  await db.end();
  delete globalThis.__attendanceTest;
}
