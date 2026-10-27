import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
import {
  parseSharedLocation,
  locationFromPayload,
  locationMapUrl,
} from "../src/lib/whatsapp-location.ts";
import {
  extractMetaInboundTextMessages,
  extractMetaSmbMessageEchoes,
} from "../src/lib/meta-inbound-parse.ts";
const { pg, db } = await isolatedPostgres();
let checks = 0;
const check = (label, fn) => {
  fn();
  checks++;
  console.log("OK", label);
};
try {
  await pg.exec(`ALTER TABLE messages ADD COLUMN external_id text, ADD COLUMN media_base64 text, ADD COLUMN media_url text, ADD COLUMN media_error text, ADD COLUMN mime_type text, ADD COLUMN media_mimetype text, ADD COLUMN media_filename text, ADD COLUMN media_caption text, ADD COLUMN media_size integer, ADD COLUMN media_type text;
 ALTER TABLE conversations ADD COLUMN last_message text;
 ALTER TABLE whatsapp_channels ADD COLUMN status text DEFAULT 'ACTIVE',ADD COLUMN evolution_instance_name text,ADD COLUMN phone_number_id text;`);
  const insert = async (q) => (await q)[0].id;
  const a = await insert(db`INSERT INTO companies(name) VALUES('A') RETURNING id`),
    b = await insert(db`INSERT INTO companies(name) VALUES('B') RETURNING id`);
  const admin = await insert(
    db`INSERT INTO users(company_id,name,role) VALUES(${a}::uuid,'Admin','ADMIN_EMPRESA') RETURNING id`,
  );
  const teammate = await insert(
    db`INSERT INTO users(company_id,name,role) VALUES(${a}::uuid,'Colega','ATENDENTE') RETURNING id`,
  );
  const outsider = await insert(
    db`INSERT INTO users(company_id,name,role) VALUES(${b}::uuid,'Outra empresa','ATENDENTE') RETURNING id`,
  );
  const channel = await insert(
    db`INSERT INTO whatsapp_channels(company_id,name,phone_number_id) VALUES(${a}::uuid,'Canal A','123') RETURNING id`,
  );
  const channel2 = await insert(
    db`INSERT INTO whatsapp_channels(company_id,name,phone_number_id) VALUES(${a}::uuid,'Canal A2','456') RETURNING id`,
  );
  const channelB = await insert(
    db`INSERT INTO whatsapp_channels(company_id,name) VALUES(${b}::uuid,'Canal B') RETURNING id`,
  );
  async function conv(company, ch) {
    const contact = await insert(
      db`INSERT INTO contacts(company_id,name,phone) VALUES(${company}::uuid,'Cliente','5534999999999') RETURNING id`,
    );
    return insert(
      db`INSERT INTO conversations(company_id,contact_id,whatsapp_channel_id,status) VALUES(${company}::uuid,${contact}::uuid,${ch}::uuid,'open') RETURNING id`,
    );
  }
  const sourceConv = await conv(a, channel),
    dest = await conv(a, channel2),
    foreign = await conv(b, channelB);
  const textId = await insert(
    db`INSERT INTO messages(conversation_id,direction,message_type,message_text) VALUES(${sourceConv}::uuid,'in','text','Mensagem original') RETURNING id`,
  );
  const foreignMessage = await insert(
    db`INSERT INTO messages(conversation_id,direction,message_type,message_text) VALUES(${foreign}::uuid,'in','text','Segredo B') RETURNING id`,
  );
  const loc = { latitude: 0, longitude: -48.2, name: "Loja", address: "Rua A" };
  const locationId = await insert(
    db`INSERT INTO messages(conversation_id,direction,message_type,message_text,raw_payload) VALUES(${sourceConv}::uuid,'in','location','Localização',${{ message: { location: loc } }}::jsonb) RETURNING id`,
  );
  const imageId = await insert(
    db`INSERT INTO messages(conversation_id,direction,message_type,media_base64,mime_type,media_filename) VALUES(${sourceConv}::uuid,'in','image','iVBORw0KGgo=','image/png','foto.png') RETURNING id`,
  );
  const docId = await insert(
    db`INSERT INTO messages(conversation_id,direction,message_type,media_base64,mime_type,media_filename) VALUES(${sourceConv}::uuid,'in','document','JVBERi0xLjQ=','application/pdf','arquivo.pdf') RETURNING id`,
  );
  const chat = await insert(
    db`INSERT INTO internal_chats(company_id,name,type,created_by) VALUES(${a}::uuid,'Equipe','group',${admin}::uuid) RETURNING id`,
  );
  await db`INSERT INTO internal_chat_members(chat_id,user_id) VALUES(${chat}::uuid,${admin}::uuid),(${chat}::uuid,${teammate}::uuid)`;
  const foreignChat = await insert(
    db`INSERT INTO internal_chats(company_id,name,type,created_by) VALUES(${b}::uuid,'Grupo B','group',${outsider}::uuid) RETURNING id`,
  );
  let uid = admin;
  const sends = [],
    uploads = [];
  const dispatch = async (p) => {
    sends.push(p);
    const id = await insert(
      db`INSERT INTO messages(conversation_id,direction,message_type,message_text,status) VALUES(${p.conversationId}::uuid,'out',${p.file ? p.mediaType : "text"},${p.text ?? p.caption ?? ""},'sent') RETURNING id`,
    );
    return { ok: true, provider: "meta", message: { id } };
  };
  const overrides = {
    "@/lib/pg.server": { sql: () => db, getSql: () => db },
    "@/lib/company.server": {
      requireCompanyId: () => (uid ? a : Response.json({ error: "unauthorized" }, { status: 401 })),
      getCurrentUserCompanyInfo: async () => ({
        role: uid === admin ? "ADMIN_EMPRESA" : "ATENDENTE",
        userId: uid,
        companyId: a,
      }),
    },
    "@/lib/session.server": { getSessionUserId: () => uid },
    "@/lib/message-send-router.server": { sendConversationText: dispatch },
    "@/lib/document-send.server": { sendConversationDocument: dispatch },
    "@/lib/whatsapp/whatsapp-provider-router.server": { loadChannelForCompany: async () => null },
    "@/lib/meta-media-download.server": {
      metaGraphApiVersion: () => "v25.0",
      downloadMetaMedia: async () => ({ ok: false, error: "expired" }),
    },
    "@/lib/internal-upload.server": {
      saveInternalAttachment: async (f) => {
        uploads.push({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) });
        return {
          path: randomUUID() + ".png",
          mimeType: f.type,
          filename: f.name,
          originalName: f.name,
          size: f.size,
          type: f.type.startsWith("image/") ? "image" : "document",
        };
      },
      UploadError: class extends Error {},
    },
  };
  const load = tsLoader(overrides);
  const { forwardMessage } = load("src/lib/message-forward.server.ts");
  const call = (messageId, target, extra = {}) =>
    forwardMessage(
      new Request("https://example.test/api/messages/forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, target, ...extra }),
      }),
    );
  let response = await call(textId, { kind: "external", conversationId: dest });
  assert.equal(response.status, 200);
  check("texto externo e auditoria sem alterar original", () =>
    assert.equal(sends.at(-1).text, "Mensagem original"),
  );
  const [copy] =
    await db`SELECT raw_payload FROM messages WHERE id=${(await response.json()).message.id}::uuid`;
  assert.equal(copy.raw_payload.__nexaForward.sourceMessageId, textId);
  assert.equal(
    (await db`SELECT message_text FROM messages WHERE id=${textId}::uuid`)[0].message_text,
    "Mensagem original",
  );
  let count = sends.length;
  assert.equal(
    (await call(foreignMessage, { kind: "external", conversationId: dest })).status,
    404,
  );
  assert.equal((await call(textId, { kind: "external", conversationId: foreign })).status, 404);
  check("origem e destino de outra empresa bloqueados sem envio", () =>
    assert.equal(sends.length, count),
  );
  assert.equal((await call(textId, { kind: "external", conversationId: sourceConv })).status, 400);
  assert.equal(
    (
      await call(
        textId,
        { kind: "external", conversationId: dest },
        { text: "Conteúdo adulterado" },
      )
    ).status,
    400,
  );
  checks += 2;
  response = await call(imageId, { kind: "external", conversationId: dest });
  assert.equal(response.status, 200);
  check("imagem externa reutiliza bytes protegidos e mantém tipo", () => {
    assert.equal(sends.at(-1).mediaType, "image");
    assert.equal(sends.at(-1).file.type, "image/png");
  });
  response = await call(docId, { kind: "external", conversationId: dest });
  assert.equal(response.status, 200);
  check("documento externo preserva arquivo", () =>
    assert.equal(sends.at(-1).file.name, "arquivo.pdf"),
  );
  response = await call(locationId, { kind: "external", conversationId: dest });
  assert.equal(response.status, 200);
  check("localização externa como link do mapa", () =>
    assert.ok(sends.at(-1).text.includes(locationMapUrl(loc))),
  );
  response = await call(textId, { kind: "internal", chatId: chat });
  assert.equal(response.status, 200);
  check("grupo interno recebe cópia e notificação", () => assert.equal(response.status, 200));
  assert.equal(
    (await db`SELECT count(*)::int AS n FROM internal_notifications WHERE chat_id=${chat}::uuid`)[0]
      .n,
    1,
  );
  response = await call(imageId, { kind: "internal", chatId: chat });
  assert.equal(response.status, 200);
  check("imagem interna grava anexo em serviço existente", () =>
    assert.equal(uploads.at(-1).name, "foto.png"),
  );
  response = await call(docId, { kind: "internal", chatId: chat });
  assert.equal(response.status, 200);
  check("documento interno encaminhado como anexo", () =>
    assert.equal(uploads.at(-1).name, "arquivo.pdf"),
  );
  response = await call(locationId, { kind: "internal", chatId: chat });
  assert.equal(response.status, 200);
  const internalLocation = await response.json();
  check("localização interna preserva coordenadas", () =>
    assert.ok(internalLocation.message.body.includes(locationMapUrl(loc))),
  );
  response = await call(textId, { kind: "user", userId: teammate });
  assert.equal(response.status, 200);
  response = await call(textId, { kind: "user", userId: teammate });
  assert.equal(response.status, 200);
  const direct =
    await db`SELECT count(*)::int AS n FROM internal_chats WHERE company_id=${a}::uuid AND type='direct'`;
  check("atendente interno reutiliza conversa direta", () => assert.equal(direct[0].n, 1));
  assert.equal((await call(textId, { kind: "user", userId: outsider })).status, 403);
  assert.equal((await call(textId, { kind: "internal", chatId: foreignChat })).status, 403);
  checks += 2;
  const internalCount = (await db`SELECT count(*)::int AS n FROM internal_messages`)[0].n;
  await db`DELETE FROM internal_chat_members WHERE chat_id=${chat}::uuid AND user_id=${admin}::uuid`;
  assert.equal((await call(textId, { kind: "internal", chatId: chat })).status, 403);
  const afterInternalCount = (await db`SELECT count(*)::int AS n FROM internal_messages`)[0].n;
  check("grupo sem participação bloqueado sem gravação", () =>
    assert.equal(afterInternalCount, internalCount),
  );
  uid = teammate;
  await db`INSERT INTO company_operations_settings(company_id,restrict_channels) VALUES(${a}::uuid,true) ON CONFLICT(company_id) DO UPDATE SET restrict_channels=true`;
  count = sends.length;
  assert.equal((await call(textId, { kind: "external", conversationId: dest })).status, 403);
  await db`INSERT INTO company_channel_grants(company_id,channel_id,user_id) VALUES(${a}::uuid,${channel}::uuid,${teammate}::uuid)`;
  assert.equal((await call(textId, { kind: "external", conversationId: dest })).status, 403);
  check("permissão por canal na origem e no destino", () => assert.equal(sends.length, count));
  uid = admin;
  const note = await insert(
    db`INSERT INTO messages(conversation_id,direction,message_type,message_text) VALUES(${sourceConv}::uuid,'internal','text','Nota privada') RETURNING id`,
  );
  assert.equal((await call(note, { kind: "external", conversationId: dest })).status, 400);
  checks++;
  const missing = await insert(
    db`INSERT INTO messages(conversation_id,direction,message_type) VALUES(${sourceConv}::uuid,'in','image') RETURNING id`,
  );
  assert.equal((await call(missing, { kind: "external", conversationId: dest })).status, 409);
  checks++;
  uid = null;
  assert.equal((await call(textId, { kind: "external", conversationId: dest })).status, 401);
  checks++;
  check("coordenadas zero válidas e limites validados", () => {
    assert.deepEqual(parseSharedLocation({ latitude: 0, longitude: 0 }), {
      latitude: 0,
      longitude: 0,
      name: undefined,
      address: undefined,
    });
    for (const p of [
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: "0", longitude: 0 },
      { latitude: NaN, longitude: 0 },
      { latitude: null, longitude: null },
    ])
      assert.equal(parseSharedLocation(p), null);
  });
  const payload = {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "123" },
              messages: [
                { id: "wamid.location", from: "5534999999999", type: "location", location: loc },
              ],
            },
          },
        ],
      },
    ],
  };
  const received = extractMetaInboundTextMessages(payload);
  check("webhook Meta reconhece localização", () => {
    assert.equal(received.length, 1);
    assert.equal(received[0].messageType, "location");
  });
  payload.entry[0].changes[0].value.messages[0].location = { latitude: 200, longitude: 0 };
  assert.equal(extractMetaInboundTextMessages(payload).length, 0);
  checks++;
  const echoes = {
    entry: [
      {
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              metadata: { phone_number_id: "123" },
              message_echoes: [
                { id: "echo.loc", to: "5534999999999", type: "location", location: loc },
              ],
            },
          },
        ],
      },
    ],
  };
  check("coexistência reconhece eco de localização", () =>
    assert.equal(extractMetaSmbMessageEchoes(echoes)[0].messageType, "location"),
  );
  check("Evolution resolve localização do payload", () =>
    assert.equal(
      locationFromPayload({
        data: { message: { locationMessage: { degreesLatitude: 0, degreesLongitude: 20 } } },
      }).longitude,
      20,
    ),
  );
  // Exercita o serviço real de persistência/envio, simulando apenas Graph e configuração do canal.
  uid = admin;
  const richOverrides = { ...overrides };
  delete richOverrides["@/lib/document-send.server"];
  richOverrides["@/lib/whatsapp/whatsapp-provider-router.server"] = {
    normalizeProviderKind: (t) => t,
    getProviderByKind: () => ({}),
    resolveProviderForChannel: async (channelId) => ({
      channel: {
        id: channelId,
        companyId: a,
        channelType: "meta",
        status: "ACTIVE",
        phoneNumberId: "456",
      },
    }),
  };
  richOverrides["@/lib/whatsapp/providers/meta-whatsapp-provider.server"] = {
    loadMetaAccessToken: async () => "test-only-token",
    metaWhatsAppProvider: { hasAccessToken: async () => true },
  };
  richOverrides["@/lib/meta-channels.server"] = {
    recordMetaChannelError: async () => {},
    clearMetaChannelError: async () => {},
  };
  richOverrides["@/lib/campaign-service-status.server"] = {
    tryApplyHumanReplyFromMessage: async () => {},
  };
  const richLoad = tsLoader(richOverrides);
  const { sendConversationDocument } = richLoad("src/lib/document-send.server.ts");
  const realRequests = [];
  const graph = async (url, init) => {
    realRequests.push({ url, init });
    return Response.json(
      String(url).endsWith("/media")
        ? { id: "123456" }
        : { messages: [{ id: "wamid.forward-test" }] },
    );
  };
  await db`INSERT INTO messages(conversation_id,direction,message_type,message_text) VALUES(${dest}::uuid,'in','text','Oi')`;
  const imageFile = new File([Buffer.from("iVBORw0KGgo=", "base64")], "foto.png", {
    type: "image/png",
  });
  let sent = await sendConversationDocument({
    companyId: a,
    conversationId: dest,
    file: imageFile,
    mediaType: "image",
    sentByUserId: admin,
    fetchFn: graph,
  });
  assert.equal(sent.ok, true);
  const nativePayload = JSON.parse(realRequests.at(-1).init.body);
  check("imagem Meta nativa, upload e persistência reais", () => {
    assert.equal(nativePayload.type, "image");
    assert.equal(nativePayload.image.id, "123456");
    assert.equal(nativePayload.image.filename, undefined);
    assert.equal(sent.message.message_type, "image");
    assert.equal(sent.message.media_url, `/api/messages/${sent.message.id}/media`);
  });
  const beforeGraph = realRequests.length;
  await db`UPDATE messages SET created_at=now()-interval '25 hours' WHERE conversation_id=${dest}::uuid AND direction='in'`;
  sent = await sendConversationDocument({
    companyId: a,
    conversationId: dest,
    file: imageFile,
    mediaType: "image",
    sentByUserId: admin,
    fetchFn: graph,
  });
  check("janela Meta fechada bloqueia upload/envio de imagem", () => {
    assert.equal(sent.ok, false);
    assert.equal(sent.error, "service_window_closed");
    assert.equal(realRequests.length, beforeGraph);
  });
  const bad = await sendConversationDocument({
    companyId: a,
    conversationId: dest,
    file: new File(["<script>"], "fake.png", { type: "image/png" }),
    mediaType: "image",
    fetchFn: graph,
  });
  check("imagem com bytes inválidos bloqueada antes do provedor", () => {
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "unsupported_type");
    assert.equal(realRequests.length, beforeGraph);
  });
  const invalidRetry = await sendConversationDocument({
    companyId: a,
    conversationId: dest,
    file: imageFile,
    mediaType: "image",
    retryMessageId: docId,
    fetchFn: graph,
  });
  check("retry de documento não pode ser convertido em imagem", () =>
    assert.equal(invalidRetry.error, "invalid_retry_message_id"),
  );
  const tooLarge = await sendConversationDocument({
    companyId: a,
    conversationId: dest,
    file: new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
    mediaType: "image",
    fetchFn: graph,
  });
  check("limite de 5 MB aplicado a imagem Meta", () => assert.equal(tooLarge.status, 413));
  // Listagem expõe apenas o objeto de localização, sem liberar raw_payload.
  uid = admin;
  await pg.exec(
    "ALTER TABLE messages ADD COLUMN media_seconds integer, ADD COLUMN reaction_emoji text, ADD COLUMN reaction_to_message_id text; CREATE UNIQUE INDEX forward_dedup ON messages(conversation_id,external_message_id) WHERE external_message_id IS NOT NULL",
  );
  const routeLoad = tsLoader({
    ...overrides,
    "@tanstack/react-router": { createFileRoute: () => (config) => config },
    "@/lib/perf-diag.server": {
      withApiTiming: async (_opts, fn) =>
        fn({ timedDb: async (_label, f) => f(), setResultCount() {} }),
    },
  });
  const listRoute = routeLoad("src/routes/api/conversations/$id/messages.ts").Route.server.handlers;
  const listed = await listRoute.GET({
    request: new Request("https://example.test/api/conversations/" + sourceConv + "/messages"),
    params: { id: sourceConv },
  });
  const located = (await listed.json()).messages.find((m) => m.id === locationId);
  check("API entrega coordenadas sem expor payload completo", () => {
    assert.deepEqual(located.location, loc);
    assert.equal(located.raw_payload, undefined);
  });
  const crm = routeLoad("src/lib/crm-inbound.server.ts");
  const inbound = await crm.insertInboundTextMessage({
    sql: db,
    conversationId: sourceConv,
    externalMessageId: "location-dedup",
    messageText: "Localização",
    messageType: "location",
    rawPayload: { message: { location: loc } },
  });
  assert.equal(
    (await db`SELECT message_type FROM messages WHERE id=${inbound}::uuid`)[0].message_type,
    "location",
  );
  const replay = await crm.insertInboundTextMessage({
    sql: db,
    conversationId: sourceConv,
    externalMessageId: "location-dedup",
    messageText: "Localização",
    messageType: "location",
    rawPayload: { message: { location: loc } },
  });
  check("persistência de localização mantém deduplicação", () => assert.equal(replay, null));
  const textDefault = await crm.insertInboundTextMessage({
    sql: db,
    conversationId: sourceConv,
    externalMessageId: "text-default",
    messageText: "Texto",
    rawPayload: {},
  });
  check("persistência de texto anterior permanece compatível", () =>
    assert.equal(typeof textDefault, "string"),
  );
  const evo = routeLoad("src/lib/evolution-document-send.server.ts");
  let evoPayload;
  const evoResult = await evo.sendEvolutionDocument(
    {
      apiUrl: "https://evolution.example.test",
      apiKey: "test-only",
      instance: "a",
      number: "5534999999999",
      base64: "iVBORw0KGgo=",
      mimeType: "image/png",
      fileName: "foto.png",
      mediaType: "image",
    },
    async (_url, init) => {
      evoPayload = JSON.parse(init.body);
      return Response.json({ key: { id: "evo.image" } });
    },
  );
  check("Evolution encaminha imagem como imagem nativa", () => {
    assert.equal(evoResult.ok, true);
    assert.equal(evoPayload.mediatype, "image");
  });
  console.log(
    `PASS ${checks} cenários de localização/encaminhamento; banco isolado, nenhum envio real.`,
  );
} finally {
  await pg.close();
}
