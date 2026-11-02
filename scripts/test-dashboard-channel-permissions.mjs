import assert from "node:assert/strict";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
let count = 0;
const check = (label, fn) => {
  fn();
  count++;
  console.log("PASS", label);
};
try {
  await pg.exec(`ALTER TABLE contacts ADD COLUMN status text;
 ALTER TABLE conversations ADD COLUMN last_message text;
 ALTER TABLE whatsapp_channels ADD COLUMN status text DEFAULT 'connected',ADD COLUMN evolution_instance_name text,ADD COLUMN phone_number text;
 CREATE TABLE attendance_notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,user_id uuid,company_id uuid,title text,body text,created_at timestamptz DEFAULT now(),from_user_id uuid,read_at timestamptz,type text);
 CREATE TABLE campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES companies(id),whatsapp_channel_id uuid REFERENCES whatsapp_channels(id),name text,status text DEFAULT 'completed',created_at timestamptz DEFAULT now(),deleted_at timestamptz);
 CREATE TABLE campaign_contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,campaign_id uuid,status text,sent_at timestamptz,responded_at timestamptz,response_intent text,created_at timestamptz DEFAULT now());`);
  const id = async (q) => (await q)[0].id;
  const a = await id(db`INSERT INTO companies(name) VALUES('A') RETURNING id`),
    b = await id(db`INSERT INTO companies(name) VALUES('SECRET_COMPANY_B') RETURNING id`);
  async function user(company, name, role) {
    return id(
      db`INSERT INTO users(company_id,name,role,email) VALUES(${company}::uuid,${name},${role},${name + "@example.invalid"}) RETURNING id`,
    );
  }
  const op = await user(a, "Operador", "ATENDENTE"),
    admin = await user(a, "Admin", "ADMIN_EMPRESA"),
    manager = await user(a, "Gerente", "GERENTE"),
    teammate = await user(a, "Colega", "ATENDENTE"),
    hiddenAgent = await user(a, "SECRET_AGENT", "ATENDENTE"),
    foreign = await user(b, "SECRET_USER_B", "ATENDENTE"),
    support = await user(null, "Suporte", "TI");
  const x = await id(
      db`INSERT INTO whatsapp_channels(company_id,name,phone_number) VALUES(${a}::uuid,'VISIVEL_X','5534000000001') RETURNING id`,
    ),
    y = await id(
      db`INSERT INTO whatsapp_channels(company_id,name,phone_number) VALUES(${a}::uuid,'SECRET_CHANNEL_Y','5534000000002') RETURNING id`,
    ),
    z = await id(
      db`INSERT INTO whatsapp_channels(company_id,name,phone_number) VALUES(${b}::uuid,'SECRET_CHANNEL_B','5534000000003') RETURNING id`,
    );
  await db`INSERT INTO company_operations_settings(company_id,restrict_channels) VALUES(${a}::uuid,true)`;
  await db`INSERT INTO company_channel_grants(company_id,channel_id,user_id) VALUES(${a}::uuid,${x}::uuid,${op}::uuid),(${a}::uuid,${x}::uuid,${manager}::uuid)`;
  async function conversation(
    company,
    channel,
    name,
    assigned = null,
    status = "open",
    direction = "in",
  ) {
    const contact = await id(
      db`INSERT INTO contacts(company_id,name,phone) VALUES(${company}::uuid,${name},${channel === y ? "5534000000099" : "5534000000088"}) RETURNING id`,
    );
    const conv = await id(
      db`INSERT INTO conversations(company_id,contact_id,whatsapp_channel_id,status,last_message,last_message_at) VALUES(${company}::uuid,${contact}::uuid,${channel}::uuid,${status},${name},now()-interval '30 minutes') RETURNING id`,
    );
    await db`INSERT INTO messages(conversation_id,direction,message_type,message_text,from_me,created_at) VALUES(${conv}::uuid,${direction},'text',${name},${direction === "out"},now()-interval '30 minutes')`;
    if (assigned)
      await db`INSERT INTO conversation_assignments(conversation_id,user_id,assigned_at) VALUES(${conv}::uuid,${assigned}::uuid,now()-interval '10 minutes')`;
    return conv;
  }
  const visible = await conversation(a, x, "VISIBLE_QUEUE"),
    secret = await conversation(a, y, "SECRET_PREVIEW");
  await conversation(a, x, "VISIBLE_MINE", op, "open", "out");
  await conversation(a, x, "VISIBLE_OTHER", teammate);
  await conversation(a, y, "SECRET_MINE", op);
  await conversation(a, y, "SECRET_ASSIGNED", hiddenAgent);
  await conversation(a, y, "SECRET_FINISHED", op, "finished");
  await conversation(b, z, "SECRET_PREVIEW_B");
  for (const who of [op, manager]) {
    await db`INSERT INTO attendance_notifications(conversation_id,user_id,company_id,title,body,type) VALUES(${visible}::uuid,${who}::uuid,${a}::uuid,'VISIBLE_TRANSFER','Visível','transfer'),(${secret}::uuid,${who}::uuid,${a}::uuid,'SECRET_TRANSFER','SECRET_BODY','transfer')`;
  }
  const campaignX = await id(
      db`INSERT INTO campaigns(company_id,whatsapp_channel_id,name) VALUES(${a}::uuid,${x}::uuid,'VISIBLE_CAMPAIGN') RETURNING id`,
    ),
    campaignY = await id(
      db`INSERT INTO campaigns(company_id,whatsapp_channel_id,name) VALUES(${a}::uuid,${y}::uuid,'SECRET_CAMPAIGN') RETURNING id`,
    ),
    campaignB = await id(
      db`INSERT INTO campaigns(company_id,whatsapp_channel_id,name) VALUES(${b}::uuid,${z}::uuid,'SECRET_CAMPAIGN_B') RETURNING id`,
    );
  await db`INSERT INTO campaign_contacts(company_id,campaign_id,status,sent_at,responded_at,response_intent) VALUES(${a}::uuid,${campaignX}::uuid,'sent',now(),now(),'interested'),(${a}::uuid,${campaignX}::uuid,'failed',null,null,null),(${a}::uuid,${campaignY}::uuid,'sent',now(),null,null),(${a}::uuid,${campaignY}::uuid,'sent',now(),now(),'opt_out'),(${a}::uuid,${campaignY}::uuid,'sent',now(),now(),'not_interested'),(${b}::uuid,${campaignB}::uuid,'sent',now(),null,null)`;
  let uid = op,
    role = "ATENDENTE",
    authenticated = true;
  const load = tsLoader({
    "@tanstack/react-router": { createFileRoute: () => (config) => config },
    "@/lib/pg.server": { sql: () => db, getSql: () => db },
    "@/lib/session.server": { getSessionUserId: () => (authenticated ? uid : null) },
    "@/lib/company.server": {
      requireCompanyId: async () =>
        authenticated ? a : Response.json({ error: "unauthenticated" }, { status: 401 }),
      getCurrentUserCompanyInfo: async () => ({ userId: uid, role, companyId: a }),
    },
    "@/lib/attendance.server": {
      requireAttendanceActor: async () =>
        authenticated
          ? { userId: uid, companyId: a, role, name: "Teste" }
          : Response.json({ error: "unauthenticated" }, { status: 401 }),
      canTransferAny: (r) => ["GERENTE", "ADMIN_EMPRESA", "TI"].includes(r),
    },
  });
  const dash = load("src/routes/api/dashboard.ts").Route.server.handlers;
  const campaigns = load("src/routes/api/dashboard/campaigns.ts").Route.server.handlers;
  const wait = load("src/routes/api/dashboard/wait.ts").Route.server.handlers;
  const getDash = async () => {
    const response = await dash.GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    return response.json();
  };
  const getCampaigns = async () => {
    const response = await campaigns.GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    return response.json();
  };
  const getWait = async () => {
    const response = await wait.GET({
      request: new Request("https://example.test/api/dashboard/wait?preset=month"),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    return response.json();
  };
  let data = await getDash();
  check("número sem liberação não aparece em nenhuma seção do dashboard", () => {
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes("SECRET"));
    assert.ok(!serialized.includes(y));
    assert.ok(!serialized.includes("5534000000099"));
    assert.deepEqual(
      data.channels.items.map((c) => c.id),
      [x],
    );
    assert.equal(data.channel_scope, "restricted");
  });
  check("contadores e prévias mantêm apenas os atendimentos autorizados", () => {
    assert.equal(data.cards.open, 2);
    assert.equal(data.cards.unassigned, 1);
    assert.equal(data.cards.mine, 1);
    assert.equal(data.cards.finished_today, 0);
    assert.equal(data.recent.length, 2);
    assert.equal(data.by_channel.length, 1);
  });
  check("notificação antiga de número revogado não vaza título/corpo", () => {
    assert.equal(data.critical.transferred_to_me.length, 1);
    assert.equal(data.critical.transferred_to_me[0].conversation_id, visible);
  });
  let stats = await getCampaigns();
  check("campanhas e métricas excluem número não liberado", () => {
    assert.equal(stats.metrics.messagesSent, 1);
    assert.equal(stats.metrics.responsesReceived, 1);
    assert.equal(stats.metrics.interested, 1);
    assert.equal(stats.metrics.sendErrors, 1);
    assert.equal(stats.recentCampaigns.length, 1);
    assert.ok(!JSON.stringify(stats).includes("SECRET"));
  });
  uid = manager;
  role = "GERENTE";
  data = await getDash();
  check("perfil gerente não ultrapassa a restrição por número", () => {
    assert.equal(data.cards.open, 3);
    assert.ok(!JSON.stringify(data).includes("SECRET"));
    assert.ok(!data.by_attendant.some((a) => a.user_id === hiddenAgent));
  });
  let report = await getWait();
  check("tempo de espera filtra fila, histórico, médias e agentes", () => {
    assert.equal(report.summary.waitingNowCount, 1);
    assert.equal(report.summary.assumedCount, 2);
    assert.equal(report.summary.avgWaitSeconds, 600);
    assert.equal(report.queue.length, 1);
    assert.ok(!JSON.stringify(report).includes("SECRET"));
  });
  uid = op;
  role = "ATENDENTE";
  const attendantWait = await wait.GET({
    request: new Request("https://example.test/api/dashboard/wait"),
  });
  check("atendente continua sem acesso ao relatório gerencial de espera", () =>
    assert.equal(attendantWait.status, 403),
  );
  const team = await id(
    db`INSERT INTO company_teams(company_id,name) VALUES(${a}::uuid,'Equipe autorizada') RETURNING id`,
  );
  await db`INSERT INTO company_team_members(company_id,team_id,user_id) VALUES(${a}::uuid,${team}::uuid,${op}::uuid)`;
  await db`INSERT INTO company_channel_grants(company_id,channel_id,team_id) VALUES(${a}::uuid,${y}::uuid,${team}::uuid)`;
  data = await getDash();
  stats = await getCampaigns();
  check("liberação individual soma com a da equipe nos dois dashboards", () => {
    assert.equal(data.channels.total, 2);
    assert.equal(data.cards.finished_today, 1);
    assert.equal(stats.metrics.messagesSent, 4);
    assert.equal(stats.recentCampaigns.length, 2);
  });
  await db`DELETE FROM company_team_members WHERE user_id=${op}::uuid`;
  data = await getDash();
  stats = await getCampaigns();
  check("remover membro revoga a visão na consulta seguinte", () => {
    assert.equal(data.channels.total, 1);
    assert.ok(!JSON.stringify(data).includes("SECRET"));
    assert.equal(stats.metrics.messagesSent, 1);
  });
  await db`DELETE FROM company_channel_grants WHERE user_id=${op}::uuid`;
  data = await getDash();
  stats = await getCampaigns();
  check("usuário sem liberação recebe dashboard vazio", () => {
    assert.equal(data.channels.total, 0);
    assert.equal(data.recent.length, 0);
    assert.equal(data.cards.open, 0);
    assert.equal(data.cards.mine, 0);
    assert.equal(data.cards.unassigned, 0);
    assert.equal(data.critical.transferred_to_me.length, 0);
    assert.equal(data.by_channel.length, 0);
    assert.equal(stats.metrics.messagesSent, 0);
    assert.deepEqual(stats.recentCampaigns, []);
  });
  await db`DELETE FROM company_channel_grants WHERE user_id=${manager}::uuid`;
  uid = manager;
  role = "GERENTE";
  data = await getDash();
  report = await getWait();
  check("gerente sem números liberados recebe relatórios vazios", () => {
    assert.equal(data.channels.total, 0);
    assert.deepEqual(
      data.by_attendant.map((u) => u.user_id),
      [manager],
    );
    assert.equal(report.summary.assumedCount, 0);
    assert.equal(report.summary.waitingNowCount, 0);
    assert.deepEqual(report.queue, []);
    assert.deepEqual(report.agents, []);
  });
  uid = admin;
  role = "ADMIN_EMPRESA";
  data = await getDash();
  stats = await getCampaigns();
  report = await getWait();
  check("administrador mantém acesso integral apenas à empresa atual", () => {
    assert.equal(data.channel_scope, "all");
    assert.equal(data.channels.total, 2);
    assert.equal(stats.metrics.messagesSent, 4);
    assert.equal(report.summary.waitingNowCount, 2);
    for (const payload of [data, stats, report])
      assert.ok(!JSON.stringify(payload).includes("SECRET_CHANNEL_B"));
    assert.ok(!JSON.stringify(data).includes("SECRET_PREVIEW_B"));
    assert.ok(!JSON.stringify(stats).includes("SECRET_CAMPAIGN_B"));
  });
  uid = support;
  role = "TI";
  data = await getDash();
  check("suporte mantém acesso sem atravessar a empresa selecionada", () => {
    assert.equal(data.channels.total, 2);
    assert.ok(!JSON.stringify(data).includes("SECRET_CHANNEL_B"));
  });
  uid = op;
  role = "ATENDENTE";
  await db`UPDATE company_operations_settings SET restrict_channels=false WHERE company_id=${a}::uuid`;
  data = await getDash();
  stats = await getCampaigns();
  check("restrição desativada preserva comportamento anterior", () => {
    assert.equal(data.channels.total, 2);
    assert.equal(data.channel_scope, "all");
    assert.equal(stats.metrics.messagesSent, 4);
  });
  await db`UPDATE company_operations_settings SET restrict_channels=true WHERE company_id=${a}::uuid`;
  await db`INSERT INTO company_channel_grants(company_id,channel_id,user_id) VALUES(${a}::uuid,${x}::uuid,${op}::uuid)`;
  await db`UPDATE whatsapp_channels SET active=false WHERE id=${x}::uuid`;
  data = await getDash();
  check("canal inativo não é liberado por concessão antiga", () =>
    assert.equal(data.channels.total, 0),
  );
  await db`UPDATE whatsapp_channels SET active=true,deleted_at=now() WHERE id=${x}::uuid`;
  data = await getDash();
  check("canal removido não reaparece em relatórios", () => assert.equal(data.channels.total, 0));
  await db`UPDATE whatsapp_channels SET deleted_at=null WHERE id=${x}::uuid`;
  await db`UPDATE users SET active=false WHERE id=${op}::uuid`;
  data = await getDash();
  check("usuário inativo não recebe dados pelo filtro de canal", () =>
    assert.equal(data.channels.total, 0),
  );
  await db`UPDATE users SET active=true WHERE id=${op}::uuid`;
  authenticated = false;
  const unauthorizedDash = await dash.GET(),
    unauthorizedCampaigns = await campaigns.GET();
  check("sem sessão não há acesso aos dashboards", () => {
    assert.equal(unauthorizedDash.status, 401);
    assert.equal(unauthorizedCampaigns.status, 401);
  });
  authenticated = true;
  await pg.exec("ALTER TABLE company_channel_grants RENAME TO hidden_grants");
  const unavailableDash = await dash.GET();
  check("dashboard não libera dados quando a autorização falha", () =>
    assert.equal(unavailableDash.status, 503),
  );
  const unavailable = await campaigns.GET();
  const unavailablePayload = await unavailable.json();
  check("falha na consulta de permissões não libera dados", () => {
    assert.equal(unavailable.status, 503);
    assert.equal(unavailablePayload.error, "dashboard_unavailable");
    assert.equal(unavailablePayload.metrics, undefined);
    assert.equal(unavailablePayload.recentCampaigns, undefined);
  });
  await pg.exec("ALTER TABLE hidden_grants RENAME TO company_channel_grants");
  console.log(
    `PASS ${count} cenários do dashboard por número; PostgreSQL isolado e nenhum dado real.`,
  );
} finally {
  await pg.close();
}
