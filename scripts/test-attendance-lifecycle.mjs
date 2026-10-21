/** Real PostgreSQL + existing Meta send/persistence pipeline. Only Graph/auth/channel configuration are simulated.
 * Requires ATTENDANCE_TEST_DATABASE_URL on loopback, with a database ending in _test.
 * Does not create profile-name columns, lifecycle queues or migrations.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const url = process.env.ATTENDANCE_TEST_DATABASE_URL;
if (!url) throw new Error("Use a disposable local ATTENDANCE_TEST_DATABASE_URL ending in _test");
const address = new URL(url);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(address.hostname));
assert.match(address.pathname, /_test$/);
const db = postgres(url, { max: Number(process.env.ATTENDANCE_TEST_POOL_MAX ?? 8), onnotice() {} });
const state = {
  db,
  channels: [],
  sent: [],
  requests: 0,
  logs: [],
  failNext: false,
  failAt: 0,
  beforeGraph: null,
  afterGraph: null,
  failSessionSave: false,
};
const rawConsole = { log: console.log, error: console.error, warn: console.warn };
console.log = (...args) => state.logs.push(args);
console.error = (...args) => state.logs.push(args);
console.warn = (...args) => state.logs.push(args);
const tagged = (strings, ...values) => {
  if (
    state.failSessionSave &&
    strings.join("").includes("INSERT INTO public.automation_sessions")
  ) {
    state.failSessionSave = false;
    throw new Error("simulated_session_save_failure");
  }
  return db(strings, ...values);
};
globalThis.__attendanceTest = { ...state };
// Both functions and mutable values use the same object.
globalThis.__attendanceTest = state;
state.tagged = tagged;
state.graphSend = async (channel, message) => {
  state.requests++;
  if (state.beforeGraph) await state.beforeGraph(channel, message);
  if (state.failNext || state.failAt === state.requests) {
    state.failNext = false;
    return { ok: false, error: "test_send_failed", errorCode: "test_send_failed" };
  }
  const event = { channelId: channel.id, text: message.text, phone: message.to };
  state.sent.push(event);
  if (state.afterGraph) await state.afterGraph(channel, message);
  return { ok: true, providerMessageId: "test-wamid-" + randomUUID() };
};
const mocks = {
  "pg.server": `export const getSql=()=>globalThis.__attendanceTest.db;
 export function sql(strings,...values){return strings?globalThis.__attendanceTest.tagged(strings,...values):globalThis.__attendanceTest.tagged;}`,
  "company.server": `export const requireCompanyId=()=>{throw new Error('unexpected auth')}; export const getCurrentUserCompanyInfo=()=>null;`,
  "session.server": `export const getSessionUserId=()=>null;`,
  "meta-channels.server": `export const clearMetaChannelError=async()=>{}; export const recordMetaChannelError=async()=>{};`,
  "meta-message-templates.server": `export const toMetaTemplatePublic=()=>({});`,
  "meta-media-download.server": `export const downloadMetaMedia=async()=>({ok:false,error:'test_media_unavailable'});`,
  "campaign-response.server": `export const handleCampaignInboundReply=async()=>null;`,
  "whatsapp/providers/meta-whatsapp-provider.server": `export const loadMetaAccessToken=async()=>'local-test-token';
 export const metaWhatsAppProvider={hasAccessToken:async()=>true,sendText:(channel,to,text)=>globalThis.__attendanceTest.graphSend(channel,{to,text})};`,
  "whatsapp/whatsapp-provider-router.server": `export const normalizeProviderKind=value=>value==='meta'?'meta':'evolution';
 export const getProviderByKind=()=>({});
 export const loadMetaChannelByPhoneNumberId=async value=>globalThis.__attendanceTest.channels.find(c=>c.phoneNumberId===value&&c.active&&!c.deletedAt)??null;
 export const resolveProviderForChannel=async(id,company)=>{const channel=globalThis.__attendanceTest.channels.find(c=>c.id===id&&c.companyId===company);
 return channel?{channel,provider:{sendText:(c,to,text)=>globalThis.__attendanceTest.graphSend(c,{to,text})}}:null;};`,
};
const bundled = await build({
  stdin: {
    contents: `export * from './src/lib/attendance-inbound.server';
 export * from './src/lib/attendance-jobs.server'; export * from './src/lib/automation-flow.server';
 export {persistMetaInboundMessages,persistMetaSmbMessageEchoes} from './src/lib/meta-inbound-message.server';
 export {sendConversationText} from './src/lib/message-send-router.server';
 export {onCampaignFinish} from './src/lib/campaign-service-status.server';`,
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
      name: "external-boundaries",
      setup(b) {
        b.onResolve({ filter: /^@\/lib\// }, (args) => {
          const name = args.path.slice("@/lib/".length);
          if (name in mocks) return { path: name, namespace: "mock" };
        });
        b.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
          contents: mocks[args.path],
          loader: "js",
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const api = module.exports;
if (process.env.ATTENDANCE_TEST_DRAIN_CONVERSATION) {
  process.env.NODE_ENV = "production";
  const channels = await db`SELECT id,company_id FROM whatsapp_channels`;
  state.channels = channels.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    phoneNumberId: "channel-" + row.id,
    channelType: "meta",
    status: "ACTIVE",
    tokenStatus: "valid",
    active: true,
  }));
  try {
    await api.drainAttendanceJobs(process.env.ATTENDANCE_TEST_DRAIN_CONVERSATION);
  } finally {
    await db.end();
    Object.assign(console, rawConsole);
    delete globalThis.__attendanceTest;
  }
  process.exit(0);
}
let checks = 0,
  number = 1000,
  sequence = 0;
const company = randomUUID(),
  channel = randomUUID();
const phone = () => "5511987" + String(++number).padStart(6, "0");
const input = (extra = {}) => ({
  companyId: company,
  channelId: channel,
  phone: phone(),
  text: "Oi",
  externalMessageId: "in-" + ++sequence,
  rawPayload: { original: true },
  ...extra,
});
const emit = async (p) => {
  const row = await api.commitMetaAttendanceMessage(p);
  await api.drainAttendanceJobs(row.conversationId);
  return row;
};
const count = async (id, direction = "out") =>
  Number(
    (
      await db`SELECT count(*) AS n FROM messages WHERE conversation_id=${id} AND direction=${direction}`
    )[0].n,
  );
const session = async (id) =>
  (await db`SELECT * FROM automation_sessions WHERE conversation_id=${id}`)[0];
const mark = async (id) =>
  (await db`SELECT raw_payload->'__nexaFlow' AS state FROM messages WHERE id=${id}`)[0].state;
const due = async (id) =>
  db`UPDATE messages SET raw_payload=jsonb_set(raw_payload,'{__nexaFlow,availableAt}',to_jsonb(now()-interval '1 second')) WHERE id=${id}`;
async function scenario(name, fn) {
  try {
    await fn();
    checks++;
    process.stdout.write("PASS " + checks + ": " + name + "\n");
  } catch (error) {
    process.stderr.write(
      JSON.stringify(
        {
          logs: state.logs.slice(-18),
          messages:
            await db`SELECT direction,raw_payload FROM messages ORDER BY created_at DESC LIMIT 3`,
          sessions: await db`SELECT * FROM automation_sessions ORDER BY updated_at DESC LIMIT 3`,
        },
        null,
        2,
      ) + "\n",
    );
    throw error;
  } finally {
    state.failNext = false;
    state.failAt = 0;
    state.beforeGraph = null;
    state.afterGraph = null;
    state.failSessionSave = false;
  }
}
async function addChannel(id, tenant) {
  const c = {
    id,
    companyId: tenant,
    phoneNumberId: "channel-" + id,
    channelType: "meta",
    status: "ACTIVE",
    tokenStatus: "valid",
    active: true,
    deletedAt: null,
    name: "Local test",
  };
  state.channels.push(c);
  await db`INSERT INTO whatsapp_channels(id,company_id,channel_type,name,active) VALUES (${id},${tenant},'meta','Local test',true)`;
  return c;
}
async function flow(tenant, id, definition, status = "active") {
  const flowId = randomUUID();
  await db`INSERT INTO automation_flows(id,company_id,name,kind,status,definition) VALUES (${flowId},${tenant},'Existing flow','attendance',${status},${db.json(definition)})`;
  await db`INSERT INTO automation_flow_channels(flow_id,channel_id,company_id) VALUES (${flowId},${id},${tenant})`;
  return flowId;
}
const basic = {
  entryStepId: "welcome",
  steps: [
    {
      id: "welcome",
      type: "buttons",
      text: "Olá, {{nome}}! Como ajudar?",
      buttons: [{ id: "1", label: "Ajuda", next: "end" }],
    },
    { id: "end", type: "end", text: "Até logo!" },
  ],
};
const withFlow = async (definition) => {
  const id = randomUUID();
  await addChannel(id, company);
  await flow(company, id, definition);
  return id;
};
const payload = (p, type = "text", extra = {}) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            metadata: {
              phone_number_id: state.channels.find((c) => c.id === p.channelId).phoneNumberId,
            },
            contacts: [{ wa_id: p.phone, profile: { name: "Nome adiado" } }],
            messages: [
              {
                id: p.externalMessageId,
                from: p.phone,
                type,
                ...(type === "text" ? { text: { body: p.text } } : {}),
                ...extra,
              },
            ],
          },
        },
      ],
    },
  ],
});
let first, second, baseFlow;
try {
  await db.unsafe(`CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,phone text,phone_match text,name text,name_source text,status text,reference text,external_jid text,contact_type text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE UNIQUE INDEX contact_phone ON contacts(company_id,phone_match) WHERE status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo';
 CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,contact_id uuid REFERENCES contacts,whatsapp_channel_id uuid,status text,unread_count int DEFAULT 0,last_message text,last_message_at timestamptz,campaign_reply_campaign_id uuid,campaign_service_status text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES conversations,external_id text,external_message_id text,direction text,message_type text,message_text text,from_me boolean,raw_payload jsonb,status text,sent_by_name text,sent_by_user_id uuid,media_type text,media_mimetype text,mime_type text,media_filename text,media_caption text,media_base64 text,media_error text,media_url text,media_size bigint,created_at timestamptz DEFAULT now());
 CREATE UNIQUE INDEX message_identity ON messages(conversation_id,external_message_id) WHERE external_message_id IS NOT NULL;
 CREATE TABLE conversation_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,user_id uuid,active boolean,unassigned_at timestamptz);
 CREATE TABLE whatsapp_channels(id uuid PRIMARY KEY,company_id uuid,channel_type text,name text,evolution_instance_name text,active boolean,deleted_at timestamptz,last_webhook_at timestamptz,last_connected_at timestamptz);`);
  await db.unsafe(readFileSync("scripts/migrations/20260926_automation_flows.sql", "utf8"));
  process.env.NODE_ENV = "production";
  const initialTables =
    await db`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  await addChannel(channel, company);
  baseFlow = await flow(company, channel, basic);
  await scenario("pipeline Meta completo inicia Olá para número desconhecido", async () => {
    const p = input();
    const result = await api.persistMetaInboundMessages(payload(p));
    assert.equal(result.saved, 1);
    first = (
      await db`SELECT id AS "conversationId",contact_id AS "contactId" FROM conversations WHERE contact_id=(SELECT id FROM contacts WHERE phone=${p.phone})`
    )[0];
    assert.equal(await count(first.conversationId), 1);
    assert.match(state.sent.at(-1).text, /Olá!/);
    assert.equal(
      (await db`SELECT unread_count FROM conversations WHERE id=${first.conversationId}`)[0]
        .unread_count,
      1,
    );
  });
  await scenario("não depende da tabela de fila ou das colunas adiadas", async () => {
    assert.equal(
      (await db`SELECT to_regclass('public.attendance_automation_jobs') AS name`)[0].name,
      null,
    );
    assert.equal(
      (
        await db`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('whatsapp_profile_name','message_source')`
      )[0].n,
      0,
    );
  });
  await scenario("preserva nome manual e mantém saudação sem nome", async () => {
    await db`UPDATE contacts SET name='Nome confirmado',name_source='manual' WHERE id=${first.contactId}`;
    await api.onCampaignFinish({ companyId: company, conversationId: first.conversationId });
    second = await emit(
      input({
        phone: (await db`SELECT phone FROM contacts WHERE id=${first.contactId}`)[0].phone,
        profileName: "Novo nome",
      }),
    );
    assert.doesNotMatch(state.sent.at(-1).text, /Nome confirmado|Novo nome/);
    assert.equal(
      (await db`SELECT name FROM contacts WHERE id=${first.contactId}`)[0].name,
      "Nome confirmado",
    );
  });
  await scenario("novo ciclo preserva ID e mensagens do atendimento finalizado", async () => {
    assert.notEqual(first.conversationId, second.conversationId);
    assert.equal(await count(first.conversationId), 1);
    assert.equal(
      (await db`SELECT status FROM conversations WHERE id=${first.conversationId}`)[0].status,
      "finished",
    );
  });
  await scenario("waiting permanece waiting sem repetir saudação", async () => {
    await db`UPDATE conversations SET status='waiting' WHERE id=${second.conversationId}`;
    const p = input({
      phone: (await db`SELECT phone FROM contacts WHERE id=${second.contactId}`)[0].phone,
      text: "Outra dúvida",
    });
    const row = await emit(p);
    assert.equal(row.conversationId, second.conversationId);
    assert.equal(
      (await db`SELECT status FROM conversations WHERE id=${row.conversationId}`)[0].status,
      "waiting",
    );
    assert.equal(
      (
        await db`SELECT count(*)::int AS n FROM messages WHERE conversation_id=${row.conversationId} AND direction='out' AND message_text LIKE 'Olá%'`
      )[0].n,
      1,
    );
  });
  await scenario(
    "resposta de botão avança e sessão ended não reinicia sem encerramento",
    async () => {
      const existingPhone = (await db`SELECT phone FROM contacts WHERE id=${second.contactId}`)[0]
        .phone;
      await emit(input({ phone: existingPhone, text: "1" }));
      assert.equal((await session(second.conversationId)).status, "ended");
      const before = await count(second.conversationId);
      await emit(input({ phone: existingPhone, text: "Oi de novo" }));
      assert.equal(await count(second.conversationId), before);
    },
  );
  await scenario("replay de wamid antigo não reabre nem cria ciclo", async () => {
    await api.onCampaignFinish({ companyId: company, conversationId: second.conversationId });
    const existing = (
      await db`SELECT external_message_id FROM messages WHERE conversation_id=${second.conversationId} AND direction='in' ORDER BY created_at LIMIT 1`
    )[0];
    const row = await emit(
      input({
        phone: (await db`SELECT phone FROM contacts WHERE id=${second.contactId}`)[0].phone,
        externalMessageId: existing.external_message_id,
      }),
    );
    assert.equal(row.messageId, null);
    assert.equal(
      (await db`SELECT status FROM conversations WHERE id=${second.conversationId}`)[0].status,
      "finished",
    );
  });
  await scenario(
    "100 mensagens e 8 processadores simultâneos: um ciclo e uma saudação",
    async () => {
      const p = input();
      const rows = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          api.commitMetaAttendanceMessage({ ...p, externalMessageId: "load-" + i }),
        ),
      );
      assert.equal(new Set(rows.map((r) => r.conversationId)).size, 1);
      await Promise.all(
        Array.from({ length: 8 }, () => api.drainAttendanceJobs(rows[0].conversationId)),
      );
      assert.equal(await count(rows[0].conversationId, "in"), 100);
      assert.equal(
        (
          await db`SELECT count(*)::int AS n FROM messages WHERE conversation_id=${rows[0].conversationId} AND direction='out' AND message_text LIKE 'Olá%'`
        )[0].n,
        1,
      );
      assert.equal(
        (
          await db`SELECT count(*)::int AS n FROM messages WHERE conversation_id=${rows[0].conversationId} AND direction='in' AND raw_payload->'__nexaFlow'->>'status'='processed'`
        )[0].n,
        100,
      );
    },
  );
  await scenario("20 entregas do mesmo wamid gravam somente uma mensagem", async () => {
    const p = input();
    const rows = await Promise.all(
      Array.from({ length: 20 }, () => api.commitMetaAttendanceMessage(p)),
    );
    assert.equal(rows.filter((r) => r.messageId).length, 1);
    await Promise.all(rows.map((r) => api.drainAttendanceJobs(r.conversationId)));
    assert.equal(await count(rows[0].conversationId, "in"), 1);
    assert.equal(await count(rows[0].conversationId), 1);
  });
  await scenario("normalização do nono dígito coordena o mesmo contato", async () => {
    const a = input({ phone: "5511998765432" }),
      b = input({ phone: "551198765432" });
    const rows = await Promise.all([
      api.commitMetaAttendanceMessage(a),
      api.commitMetaAttendanceMessage(b),
    ]);
    assert.equal(rows[0].contactId, rows[1].contactId);
    assert.equal(rows[0].conversationId, rows[1].conversationId);
  });
  await scenario("rollback não grava mensagem nem dispara bot", async () => {
    const p = input();
    const before = state.requests;
    await assert.rejects(
      db.begin(async (tx) => {
        await api.persistMetaAttendanceMessage(tx, p);
        throw new Error("test rollback");
      }),
    );
    assert.equal(
      (
        await db`SELECT count(*)::int AS n FROM messages WHERE external_message_id=${p.externalMessageId}`
      )[0].n,
      0,
    );
    assert.equal(state.requests, before);
  });
  await scenario("falha de envio preserva entrada e permite retry da mesma entrega", async () => {
    const p = input();
    state.failNext = true;
    const row = await emit(p);
    assert.equal(await count(row.conversationId, "in"), 1);
    assert.equal((await mark(row.messageId)).status, "retry");
    await due(row.messageId);
    await emit(p);
    assert.equal(await count(row.conversationId), 1);
    assert.equal((await mark(row.messageId)).status, "processed");
  });
  await scenario(
    "entrada nova recupera envio anterior pendente sem repetir mensagem recebida",
    async () => {
      const p = input();
      state.failNext = true;
      const row = await emit(p);
      await due(row.messageId);
      await emit(input({ phone: p.phone, text: "1" }));
      assert.equal(await count(row.conversationId, "in"), 2);
      assert.equal((await session(row.conversationId)).status, "ended");
    },
  );
  await scenario("lease abandonado é recuperado depois da expiração", async () => {
    const row = await api.commitMetaAttendanceMessage(input());
    await db`UPDATE messages SET raw_payload=jsonb_set(raw_payload,'{__nexaFlow}',(raw_payload->'__nexaFlow')||jsonb_build_object('status','processing','leaseUntil',now()-interval '1 second','token','abandoned')) WHERE id=${row.messageId}`;
    await api.drainAttendanceJobs(row.conversationId);
    assert.equal(await count(row.conversationId), 1);
    assert.equal((await mark(row.messageId)).status, "processed");
  });
  await scenario("lease ainda válido impede outro envio", async () => {
    const row = await api.commitMetaAttendanceMessage(input());
    await db`UPDATE messages SET raw_payload=jsonb_set(raw_payload,'{__nexaFlow}',(raw_payload->'__nexaFlow')||jsonb_build_object('status','processing','leaseUntil',now()+interval '1 minute','token','active')) WHERE id=${row.messageId}`;
    assert.equal(await api.drainAttendanceJobs(row.conversationId), 0);
    assert.equal(await count(row.conversationId), 0);
  });
  await scenario("saudação, goto e menu executam na ordem", async () => {
    const id = await withFlow({
      entryStepId: "hello",
      steps: [
        { id: "hello", type: "message", text: "Olá!", next: "jump" },
        { id: "jump", type: "goto", next: "menu" },
        {
          id: "menu",
          type: "buttons",
          text: "Menu",
          buttons: [{ id: "1", label: "Continuar", next: null }],
        },
      ],
    });
    const row = await emit(input({ channelId: id }));
    assert.equal(await count(row.conversationId), 2);
    assert.equal((await session(row.conversationId)).step_id, "menu");
  });
  await scenario("falha no menu retoma o menu sem repetir Olá", async () => {
    const id = await withFlow({
      entryStepId: "hello",
      steps: [
        { id: "hello", type: "message", text: "Olá!", next: "menu" },
        {
          id: "menu",
          type: "buttons",
          text: "Menu",
          buttons: [{ id: "1", label: "Continuar", next: null }],
        },
      ],
    });
    const p = input({ channelId: id });
    state.failAt = state.requests + 2;
    const row = await emit(p);
    assert.equal(await count(row.conversationId), 1);
    await due(row.messageId);
    state.failAt = 0;
    await emit(p);
    assert.equal(await count(row.conversationId), 2);
    assert.equal(
      (
        await db`SELECT count(*)::int AS n FROM messages WHERE conversation_id=${row.conversationId} AND message_text='Olá!'`
      )[0].n,
      1,
    );
  });
  await scenario("saída já gravada não é reenviada se salvar a sessão falhar", async () => {
    const p = input();
    state.afterGraph = async () => {
      state.failSessionSave = true;
      state.afterGraph = null;
    };
    const row = await emit(p);
    assert.equal(await count(row.conversationId), 1);
    assert.equal((await mark(row.messageId)).status, "retry");
    const before = state.requests;
    await due(row.messageId);
    await emit(p);
    assert.equal(state.requests, before);
    assert.equal((await session(row.conversationId)).status, "waiting");
  });
  await scenario("ciclo de goto inválido é limitado sem impedir recebimento", async () => {
    const id = await withFlow({
      entryStepId: "loop",
      steps: [{ id: "loop", type: "goto", next: "loop" }],
    });
    const row = await emit(input({ channelId: id }));
    assert.equal(await count(row.conversationId, "in"), 1);
    assert.equal(await count(row.conversationId), 0);
    assert.equal((await mark(row.messageId)).status, "retry");
  });
  await scenario("áudio inicia o fluxo mesmo com download indisponível", async () => {
    const p = input();
    const result = await api.persistMetaInboundMessages(
      payload(p, "audio", { audio: { id: "audio-test", mime_type: "audio/ogg" } }),
    );
    assert.equal(result.saved, 1);
    const row = (
      await db`SELECT conversation_id FROM messages WHERE external_message_id=${p.externalMessageId}`
    )[0];
    assert.equal(await count(row.conversation_id), 1);
  });
  await scenario("mídia em sessão waiting não vira resposta textual", async () => {
    const p = input();
    const row = await emit(p);
    await api.persistMetaInboundMessages(
      payload(input({ phone: p.phone }), "image", { image: { id: "image-test", caption: "1" } }),
    );
    assert.equal((await session(row.conversationId)).status, "waiting");
    assert.equal(await count(row.conversationId), 1);
  });
  await scenario("atribuição humana antes do processamento impede bot", async () => {
    const row = await api.commitMetaAttendanceMessage(input());
    await db`INSERT INTO conversation_assignments(conversation_id,user_id,active) VALUES (${row.conversationId},${randomUUID()},true)`;
    await api.drainAttendanceJobs(row.conversationId);
    assert.equal(await count(row.conversationId), 0);
  });
  await scenario(
    "humano assume durante envio e impede próximas etapas e sessão ativa",
    async () => {
      const id = await withFlow({
        entryStepId: "hello",
        steps: [
          { id: "hello", type: "message", text: "Olá!", next: "second" },
          { id: "second", type: "message", text: "Não enviar", next: null },
        ],
      });
      const p = input({ channelId: id });
      const row = await api.commitMetaAttendanceMessage(p);
      state.afterGraph = async () => {
        state.afterGraph = null;
        await db`INSERT INTO conversation_assignments(conversation_id,user_id,active) VALUES (${row.conversationId},${randomUUID()},true)`;
        await api.stopAutomationForConversation(row.conversationId, company);
      };
      await api.drainAttendanceJobs(row.conversationId);
      assert.equal(await count(row.conversationId), 1);
      assert.equal((await session(row.conversationId)).status, "transferred");
    },
  );
  await scenario("encerramento durante envio não é revertido pelo bot", async () => {
    const row = await api.commitMetaAttendanceMessage(input());
    state.afterGraph = async () => {
      state.afterGraph = null;
      await api.onCampaignFinish({ companyId: company, conversationId: row.conversationId });
    };
    await api.drainAttendanceJobs(row.conversationId);
    assert.equal(
      (await db`SELECT status FROM conversations WHERE id=${row.conversationId}`)[0].status,
      "finished",
    );
    assert.equal((await session(row.conversationId)).status, "ended");
  });
  await scenario(
    "encerrar atendimento libera atribuição e transfere retorno para outro ciclo",
    async () => {
      const p = input();
      const row = await emit(p);
      await db`INSERT INTO conversation_assignments(conversation_id,user_id,active) VALUES (${row.conversationId},${randomUUID()},true)`;
      await api.stopAutomationForConversation(row.conversationId, company);
      await api.onCampaignFinish({ companyId: company, conversationId: row.conversationId });
      const next = await emit(input({ phone: p.phone }));
      assert.notEqual(next.conversationId, row.conversationId);
      assert.equal(await count(next.conversationId), 1);
      assert.equal(
        (
          await db`SELECT active FROM conversation_assignments WHERE conversation_id=${row.conversationId}`
        )[0].active,
        false,
      );
    },
  );
  await scenario("fluxo pausado não envia nem impede gravação da entrada", async () => {
    const id = randomUUID();
    await addChannel(id, company);
    await flow(company, id, basic, "paused");
    const row = await emit(input({ channelId: id }));
    assert.equal(await count(row.conversationId), 0);
    assert.equal(await count(row.conversationId, "in"), 1);
  });
  await scenario("canal sem fluxo mantém entrada normal", async () => {
    const id = randomUUID();
    await addChannel(id, company);
    const row = await emit(input({ channelId: id }));
    assert.equal(await count(row.conversationId), 0);
    assert.equal(await count(row.conversationId, "in"), 1);
  });
  await scenario("mesmo número em outra empresa não compartilha contato nem fluxo", async () => {
    const tenant = randomUUID(),
      id = randomUUID();
    await addChannel(id, tenant);
    await flow(tenant, id, {
      entryStepId: "end",
      steps: [{ id: "end", type: "end", text: "Outro tenant" }],
    });
    const p = input();
    const original = await emit(p),
      other = await emit({ ...p, companyId: tenant, channelId: id });
    assert.notEqual(original.contactId, other.contactId);
    assert.equal(state.sent.at(-1).text, "Outro tenant");
  });
  await scenario("mesma empresa usa o fluxo do canal correto", async () => {
    const id = await withFlow({
      entryStepId: "end",
      steps: [{ id: "end", type: "end", text: "Outro canal" }],
    });
    const p = input();
    const a = await emit(p),
      b = await emit({ ...p, channelId: id });
    assert.equal(a.contactId, b.contactId);
    assert.notEqual(a.conversationId, b.conversationId);
    assert.equal(state.sent.at(-1).text, "Outro canal");
  });
  await scenario("echo em atendimento finalizado não reabre nem dispara fluxo", async () => {
    const p = input();
    const row = await emit(p);
    await api.onCampaignFinish({ companyId: company, conversationId: row.conversationId });
    const before = state.requests;
    const result = await api.persistMetaSmbMessageEchoes({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                metadata: { phone_number_id: state.channels[0].phoneNumberId },
                message_echoes: [
                  {
                    id: "echo-" + randomUUID(),
                    from: "5511000000000",
                    to: p.phone,
                    type: "text",
                    text: { body: "Mensagem do celular" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    assert.equal(result.saved, 1);
    assert.equal(state.requests, before);
    assert.equal(
      (await db`SELECT status FROM conversations WHERE id=${row.conversationId}`)[0].status,
      "finished",
    );
  });
  await scenario(
    "echo desconhecido tem zero não lidas e cliente posterior cria ciclo",
    async () => {
      const p = input();
      const echo = await api.commitMetaAttendanceMessage({ ...p, echo: true });
      assert.equal(
        (await db`SELECT unread_count FROM conversations WHERE id=${echo.conversationId}`)[0]
          .unread_count,
        0,
      );
      const next = await emit({ ...p, externalMessageId: "after-echo-" + randomUUID() });
      assert.notEqual(next.conversationId, echo.conversationId);
    },
  );
  await scenario("envio manual continua funcionando e não é deduplicado pelo bot", async () => {
    const row = await emit(input());
    const before = state.requests;
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await api.sendConversationText({
            companyId: company,
            conversationId: row.conversationId,
            text: "Manual repetido",
            sentByName: "Manual",
          })
        ).ok,
        true,
      );
    assert.equal(state.requests, before + 2);
  });
  await scenario(
    "mensagens já existentes sem controle de fluxo não são reprocessadas",
    async () => {
      const row = await emit(input());
      await db`INSERT INTO messages(conversation_id,direction,message_text,raw_payload) VALUES (${row.conversationId},'in','Histórico','{}'::jsonb)`;
      const before = state.requests;
      await api.drainAttendanceJobs(row.conversationId);
      assert.equal(state.requests, before);
    },
  );
  await scenario("índice legado não interrompe recebimento no retorno", async () => {
    // Isolate legacy index to one channel so other test attendances can coexist.
    const id = await withFlow(basic),
      p = input({ channelId: id });
    const row = await emit(p);
    await api.onCampaignFinish({ companyId: company, conversationId: row.conversationId });
    await db.unsafe(
      `CREATE UNIQUE INDEX test_legacy_conversation_unique ON conversations(company_id,whatsapp_channel_id,contact_id) WHERE whatsapp_channel_id='${id}'::uuid`,
    );
    const next = await emit(input({ channelId: id, phone: p.phone }));
    assert.equal(next.conversationId, row.conversationId);
    assert.equal(await count(row.conversationId, "in"), 2);
    assert.equal(await count(row.conversationId), 2);
    await db.unsafe("DROP INDEX test_legacy_conversation_unique");
  });
  await scenario("índice legado também retoma se não havia sessão para o histórico", async () => {
    const id = await withFlow(basic),
      p = input({ channelId: id });
    const row = await emit(p);
    await api.onCampaignFinish({ companyId: company, conversationId: row.conversationId });
    await db`DELETE FROM automation_sessions WHERE conversation_id=${row.conversationId}`;
    await db.unsafe(
      `CREATE UNIQUE INDEX test_legacy_conversation_unique ON conversations(company_id,whatsapp_channel_id,contact_id) WHERE whatsapp_channel_id='${id}'::uuid`,
    );
    await emit(input({ channelId: id, phone: p.phone }));
    assert.equal(await count(row.conversationId), 2);
    await db.unsafe("DROP INDEX test_legacy_conversation_unique");
  });
  await scenario("entrada durante o envio é processada depois, sem perder a resposta", async () => {
    const p = input();
    let entered, release;
    const started = new Promise((r) => {
        entered = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    state.beforeGraph = async () => {
      state.beforeGraph = null;
      entered();
      await gate;
    };
    const running = emit(p);
    await started;
    const next = await api.commitMetaAttendanceMessage(input({ phone: p.phone, text: "1" }));
    assert.equal(await api.drainAttendanceJobs(next.conversationId), 0);
    release();
    const row = await running;
    assert.equal((await session(row.conversationId)).status, "ended");
    assert.equal(await count(row.conversationId, "in"), 2);
  });
  await scenario("botão Meta real avança para a etapa final", async () => {
    const p = input();
    const row = await emit(p);
    const answer = input({ phone: p.phone });
    const result = await api.persistMetaInboundMessages(
      payload(answer, "button", { button: { text: "1", payload: "1" } }),
    );
    assert.equal(result.saved, 1);
    assert.equal((await session(row.conversationId)).status, "ended");
  });
  await scenario("resposta interativa Meta respeita o fluxo configurado", async () => {
    const p = input();
    const row = await emit(p);
    const answer = input({ phone: p.phone });
    const result = await api.persistMetaInboundMessages(
      payload(answer, "interactive", {
        interactive: { type: "button_reply", button_reply: { id: "1", title: "Ajuda" } },
      }),
    );
    assert.equal(result.saved, 1);
    assert.equal((await session(row.conversationId)).status, "ended");
  });
  await scenario("sessão legada com collected em texto é lida sem corromper os dados", async () => {
    const p = input();
    const row = await emit(p);
    await db`UPDATE automation_sessions SET collected=${JSON.stringify({ endereco: "Endereço existente" })}::jsonb WHERE conversation_id=${row.conversationId}`;
    await emit(input({ phone: p.phone, text: "1" }));
    assert.equal((await session(row.conversationId)).collected.endereco, "Endereço existente");
  });
  await scenario("sessão legada inválida não interrompe recebimento", async () => {
    const p = input();
    const row = await emit(p);
    await db`UPDATE automation_sessions SET collected=${"invalid-json"}::jsonb WHERE conversation_id=${row.conversationId}`;
    await emit(input({ phone: p.phone, text: "1" }));
    assert.equal((await session(row.conversationId)).status, "ended");
  });
  await scenario(
    "sessões inexistentes no banco não interrompem entrada nem criam tabela",
    async () => {
      await db.unsafe("ALTER TABLE automation_sessions RENAME TO test_saved_automation_sessions");
      let p, row;
      try {
        p = input();
        row = await emit(p);
        assert.equal(await count(row.conversationId, "in"), 1);
        assert.equal((await mark(row.messageId)).status, "retry");
        assert.equal(
          (await db`SELECT to_regclass('public.automation_sessions') AS name`)[0].name,
          null,
        );
      } finally {
        await db.unsafe("ALTER TABLE test_saved_automation_sessions RENAME TO automation_sessions");
      }
      await due(row.messageId);
      await emit(p);
      assert.equal(await count(row.conversationId), 1);
    },
  );
  await scenario("canal inativo não envia e preserva a mensagem", async () => {
    const p = input(),
      row = await api.commitMetaAttendanceMessage(p),
      c = state.channels.find((c) => c.id === channel),
      before = state.requests;
    try {
      c.status = "INACTIVE";
      await api.drainAttendanceJobs(row.conversationId);
      assert.equal(state.requests, before);
      assert.equal(await count(row.conversationId, "in"), 1);
    } finally {
      c.status = "ACTIVE";
    }
  });
  await scenario("token indisponível não provoca envio nem perda da entrada", async () => {
    const row = await api.commitMetaAttendanceMessage(input()),
      c = state.channels.find((c) => c.id === channel),
      before = state.requests;
    try {
      c.tokenStatus = "missing";
      await api.drainAttendanceJobs(row.conversationId);
      assert.equal(state.requests, before);
      assert.equal((await mark(row.messageId)).status, "retry");
    } finally {
      c.tokenStatus = "valid";
    }
  });
  await scenario("janela de serviço de 24 horas continua sendo respeitada", async () => {
    const row = await api.commitMetaAttendanceMessage(input()),
      before = state.requests;
    await db`UPDATE messages SET created_at=now()-interval '25 hours' WHERE id=${row.messageId}`;
    await api.drainAttendanceJobs(row.conversationId);
    assert.equal(state.requests, before);
    assert.equal((await mark(row.messageId)).status, "retry");
  });
  await scenario("contexto de outra empresa não pode executar o fluxo da conversa", async () => {
    const row = await emit(input()),
      before = state.requests;
    await api.onAutomationInbound({
      companyId: randomUUID(),
      channelId: channel,
      conversationId: row.conversationId,
      contactId: row.contactId,
      text: "1",
    });
    assert.equal(state.requests, before);
  });
  await scenario("notificação de status não inicia conversa nem fluxo", async () => {
    const before = state.requests;
    const result = await api.persistMetaInboundMessages({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: state.channels[0].phoneNumberId },
                statuses: [{ id: "status-test", status: "read" }],
              },
            },
          ],
        },
      ],
    });
    assert.equal(result.processed, 0);
    assert.equal(state.requests, before);
  });
  await scenario("metadados originais da mensagem são preservados", async () => {
    const row = await emit(
      input({ rawPayload: { original: true, custom: { preserve: "value" } } }),
    );
    const raw = (await db`SELECT raw_payload FROM messages WHERE id=${row.messageId}`)[0]
      .raw_payload;
    assert.equal(raw.original, true);
    assert.equal(raw.custom.preserve, "value");
    assert.equal(raw.__nexaFlow.status, "processed");
  });
  await scenario("serialização gravada é objeto JSON em entrada, saída e sessão", async () => {
    const row = await emit(input());
    const types =
      await db`SELECT jsonb_typeof(raw_payload) AS kind FROM messages WHERE conversation_id=${row.conversationId}`;
    assert.ok(types.every((r) => r.kind === "object"));
    assert.equal(
      (
        await db`SELECT jsonb_typeof(collected) AS kind FROM automation_sessions WHERE conversation_id=${row.conversationId}`
      )[0].kind,
      "object",
    );
  });
  await scenario("três rodadas concorrentes adicionais mantêm uma única saudação", async () => {
    for (let round = 0; round < 3; round++) {
      const p = input();
      const rows = await Promise.all(
        Array.from({ length: 30 }, () =>
          api.commitMetaAttendanceMessage({ ...p, externalMessageId: randomUUID() }),
        ),
      );
      await Promise.all(
        Array.from({ length: 6 }, () => api.drainAttendanceJobs(rows[0].conversationId)),
      );
      assert.equal(
        (
          await db`SELECT count(*)::int AS n FROM messages WHERE conversation_id=${rows[0].conversationId} AND direction='out' AND message_text LIKE 'Olá%'`
        )[0].n,
        1,
      );
      assert.equal(await count(rows[0].conversationId, "in"), 30);
    }
  });
  await scenario(
    "dois processos independentes disputam o mesmo atendimento sem duplicar",
    async () => {
      const p = input();
      const rows = await Promise.all(
        Array.from({ length: 20 }, () =>
          api.commitMetaAttendanceMessage({ ...p, externalMessageId: randomUUID() }),
        ),
      );
      const worker = () =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
            cwd: process.cwd(),
            env: { ...process.env, ATTENDANCE_TEST_DRAIN_CONVERSATION: rows[0].conversationId },
            stdio: ["ignore", "pipe", "pipe"],
            signal: AbortSignal.timeout(30000),
          });
          let output = "";
          child.stdout.on("data", (b) => (output += b));
          child.stderr.on("data", (b) => (output += b));
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(output || "worker failed")),
          );
        });
      await Promise.all([worker(), worker()]);
      assert.equal(
        (
          await db`SELECT count(*)::int AS n FROM messages WHERE conversation_id=${rows[0].conversationId} AND direction='out' AND message_text LIKE 'Olá%'`
        )[0].n,
        1,
      );
      assert.equal(
        (
          await db`SELECT count(*)::int AS n FROM messages WHERE conversation_id=${rows[0].conversationId} AND direction='in' AND raw_payload->'__nexaFlow'->>'status'='processed'`
        )[0].n,
        20,
      );
    },
  );
  await scenario("processador que perdeu a posse não envia nem altera a sessão", async () => {
    const row = await api.commitMetaAttendanceMessage(input()),
      before = state.requests;
    await db`UPDATE messages SET raw_payload=jsonb_set(raw_payload,'{__nexaFlow}',(raw_payload->'__nexaFlow')||jsonb_build_object('status','processing','token','new-owner')) WHERE id=${row.messageId}`;
    await assert.rejects(
      api.onAutomationInbound({
        companyId: company,
        channelId: channel,
        conversationId: row.conversationId,
        contactId: row.contactId,
        text: "Oi",
        inboundMessageId: row.messageId,
        processingToken: "old-owner",
        throwErrors: true,
      }),
      /automation_lease_lost/,
    );
    assert.equal(state.requests, before);
    assert.equal(await session(row.conversationId), undefined);
  });
  await scenario("definição legada gravada como JSON textual continua funcionando", async () => {
    const id = await withFlow(basic);
    await db`UPDATE automation_flows SET definition=${JSON.stringify(basic)}::jsonb WHERE id IN (SELECT flow_id FROM automation_flow_channels WHERE channel_id=${id})`;
    const row = await emit(input({ channelId: id }));
    assert.equal(await count(row.conversationId), 1);
    assert.equal((await session(row.conversationId)).status, "waiting");
  });
  await scenario("condição de entrada considera a mensagem recebida", async () => {
    const id = await withFlow({
      entryStepId: "condition",
      steps: [
        { id: "condition", type: "condition", match: "ajuda", yesNext: "yes", noNext: "no" },
        { id: "yes", type: "end", text: "Ajuda selecionada" },
        { id: "no", type: "end", text: "Outra opção" },
      ],
    });
    const row = await emit(input({ channelId: id, text: "Preciso de ajuda" }));
    assert.equal(await count(row.conversationId), 1);
    assert.equal(state.sent.at(-1).text, "Ajuda selecionada");
  });
  await scenario("pergunta de texto grava a resposta e avança pela condição correta", async () => {
    const id = await withFlow({
      entryStepId: "address",
      steps: [
        {
          id: "address",
          type: "ask_text",
          text: "Olá! Qual seu endereço?",
          saveAs: "endereco",
          next: "condition",
        },
        { id: "condition", type: "condition", match: "Rua", yesNext: "yes", noNext: "no" },
        { id: "yes", type: "end", text: "Recebido: {{endereco}}" },
        { id: "no", type: "end", text: "Outro endereço" },
      ],
    });
    const p = input({ channelId: id }),
      row = await emit(p);
    await emit(input({ channelId: id, phone: p.phone, text: "Rua do Teste" }));
    assert.equal((await session(row.conversationId)).status, "ended");
    assert.equal(state.sent.at(-1).text, "Recebido: Rua do Teste");
    assert.equal(
      (await db`SELECT reference FROM contacts WHERE id=${row.contactId}`)[0].reference,
      "Rua do Teste",
    );
  });
  await scenario("todo o caminho opera somente com as tabelas preexistentes", async () => {
    assert.deepEqual(
      await db`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
      initialTables,
    );
    assert.equal(
      (
        await db`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('whatsapp_profile_name','message_source')`
      )[0].n,
      0,
    );
  });
  process.stdout.write(
    "RESULT: " +
      checks +
      " scenarios passed; PostgreSQL pool max=" +
      String(process.env.ATTENDANCE_TEST_POOL_MAX ?? 8) +
      "; no new tables or profile columns.\n",
  );
} finally {
  await db.end();
  Object.assign(console, rawConsole);
  delete globalThis.__attendanceTest;
}
