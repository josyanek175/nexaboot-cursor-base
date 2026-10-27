import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
let count = 0;
const check = (label, fn) => {
  fn();
  count++;
  console.log("PASS", label);
};
try {
  const id = async (q) => (await q)[0].id;
  const a = await id(db`INSERT INTO companies(name) VALUES('A') RETURNING id`),
    b = await id(db`INSERT INTO companies(name) VALUES('B') RETURNING id`);
  const user = await id(
    db`INSERT INTO users(company_id,name,role) VALUES(${a}::uuid,'Admin A','ADMIN_EMPRESA') RETURNING id`,
  );
  const other = await id(
    db`INSERT INTO users(company_id,name,role) VALUES(${b}::uuid,'Admin B','ADMIN_EMPRESA') RETURNING id`,
  );
  const channel = await id(
    db`INSERT INTO whatsapp_channels(company_id,name) VALUES(${a}::uuid,'Número A') RETURNING id`,
  );
  await db`INSERT INTO whatsapp_channels(company_id,name) VALUES(${b}::uuid,'Número B')`;
  let role = "ADMIN_EMPRESA",
    authenticated = true,
    dbFailure = null,
    schemaQueries = 0;
  const getDb = () => {
    if (dbFailure) throw dbFailure;
    return new Proxy(db, {
      apply(target, self, args) {
        if (args[0]?.join?.("").includes("pg_catalog.pg_class")) schemaQueries++;
        return Reflect.apply(target, self, args);
      },
    });
  };
  const overrides = {
    "@tanstack/react-router": { createFileRoute: () => (config) => config },
    "@/lib/pg.server": { getSql: getDb, sql: () => getDb() },
    "@/lib/session.server": { getSessionUserId: () => (authenticated ? user : null) },
    "@/lib/company.server": {
      requireCompanyId: async () =>
        authenticated ? a : Response.json({ error: "unauthenticated" }, { status: 401 }),
      getCurrentUserCompanyInfo: async () => ({ userId: user, role, companyId: a }),
    },
  };
  const load = tsLoader(overrides);
  const { checkOperationsSchema, operationsErrorResponse, OPERATIONS_COLUMNS } = load(
    "src/lib/operations-readiness.server.ts",
  );
  const team = load("src/routes/api/team-access.ts").Route.server.handlers;
  const settings = load("src/routes/api/company-operations.ts").Route.server.handlers;
  const request = (body) =>
    new Request("https://example.test/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  check("estrutura completa está pronta", () =>
    assert.ok(OPERATIONS_COLUMNS.company_channel_grants.includes("channel_id")),
  );
  assert.equal(await checkOperationsSchema(), null);
  let response = await team.GET();
  let data = await response.json();
  check("GET saudável retorna apenas dados da empresa", () => {
    assert.equal(response.status, 200);
    assert.deepEqual(
      data.users.map((u) => u.id),
      [user],
    );
    assert.deepEqual(
      data.channels.map((c) => c.id),
      [channel],
    );
    assert.deepEqual(data.teams, []);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  });
  response = await settings.GET();
  data = await response.json();
  check("ausência de linha de configuração mantém padrão sem confundir com tabela ausente", () => {
    assert.equal(response.status, 200);
    assert.equal(data.restrict_channels, false);
  });
  response = await settings.PUT({
    request: request({
      waiting_attendant_minutes: 12,
      waiting_customer_hours: 48,
      restrict_channels: true,
    }),
  });
  assert.equal(response.status, 200);
  const saved = (
    await db`SELECT restrict_channels FROM company_operations_settings WHERE company_id=${a}::uuid`
  )[0].restrict_channels;
  check("gravação saudável mantém valores da empresa", () => assert.equal(saved, true));
  response = await team.POST({ request: request({ action: "team", name: "Equipe A" }) });
  assert.equal(response.status, 200);
  response = await team.POST({
    request: request({ action: "grant", channelId: channel, userId: other }),
  });
  check("gravação continua bloqueando usuário de outra empresa", () =>
    assert.equal(response.status, 403),
  );
  const invalid = await team.POST({ request: request({ action: "grant", channelId: "invalid" }) });
  check("entrada inválida continua sendo rejeitada", () => assert.equal(invalid.status, 400));
  await pg.exec("ALTER TABLE company_teams RENAME TO company_teams_not_ready");
  response = await team.GET();
  const missing = await response.json();
  check("tabela ausente retorna diagnóstico preciso em JSON", () => {
    assert.equal(response.status, 503);
    assert.equal(missing.error, "operations_schema_missing");
    assert.deepEqual(missing.details.missingTables, ["company_teams"]);
    assert.deepEqual(missing.details.missingColumns, []);
  });
  response = await settings.GET();
  check("configuração não é apresentada como padrão quando estrutura está incompleta", () =>
    assert.equal(response.status, 503),
  );
  response = await settings.PUT({
    request: request({
      waiting_attendant_minutes: 1,
      waiting_customer_hours: 1,
      restrict_channels: false,
    }),
  });
  assert.equal(response.status, 503);
  const preserved = (
    await db`SELECT restrict_channels FROM company_operations_settings WHERE company_id=${a}::uuid`
  )[0].restrict_channels;
  check("tentativa de salvar com estrutura incompleta não altera configuração", () =>
    assert.equal(preserved, true),
  );
  response = await team.POST({
    request: request({ action: "grant", channelId: channel, userId: user }),
  });
  assert.equal(response.status, 503);
  const grants = (await db`SELECT count(*)::int AS n FROM company_channel_grants`)[0].n;
  check("tabela ausente não libera número", () => assert.equal(grants, 0));
  const remainsMissing = (await db`SELECT to_regclass('public.company_teams') AS value`)[0].value;
  check("checagem não cria tabelas automaticamente", () => assert.equal(remainsMissing, null));
  await pg.exec("ALTER TABLE company_teams_not_ready RENAME TO company_teams");
  const recovered = await checkOperationsSchema();
  check("nova consulta reconhece estrutura pronta sem reiniciar", () =>
    assert.equal(recovered, null),
  );
  await pg.exec(
    "ALTER TABLE company_operations_settings RENAME COLUMN restrict_channels TO restrict_channels_not_ready",
  );
  response = await settings.GET();
  data = await response.json();
  check("coluna ausente é distinguida de tabela ausente", () => {
    assert.equal(response.status, 503);
    assert.deepEqual(data.details.missingTables, []);
    assert.deepEqual(data.details.missingColumns, [
      "company_operations_settings.restrict_channels",
    ]);
  });
  await pg.exec(
    "ALTER TABLE company_operations_settings RENAME COLUMN restrict_channels_not_ready TO restrict_channels",
  );
  const before = schemaQueries;
  authenticated = false;
  assert.equal((await team.GET()).status, 401);
  assert.equal((await settings.GET()).status, 401);
  check("sem sessão não consulta metadados do banco", () => assert.equal(schemaQueries, before));
  authenticated = true;
  role = "ATENDENTE";
  const beforeForbidden = schemaQueries;
  assert.equal((await team.GET()).status, 403);
  assert.equal((await settings.GET()).status, 403);
  check("perfil não autorizado não recebe diagnóstico do banco", () =>
    assert.equal(schemaQueries, beforeForbidden),
  );
  role = "GERENTE";
  const managerTeam = (await team.GET()).status,
    managerSettings = (await settings.GET()).status;
  check("gerente pode gerir equipes sem alterar configurações", () => {
    assert.equal(managerTeam, 200);
    assert.equal(managerSettings, 403);
  });
  role = "ADMIN_EMPRESA";
  for (const [code, expected] of [
    ["ECONNREFUSED", "operations_database_unavailable"],
    ["42501", "operations_database_permission"],
    ["42P01", "operations_schema_incompatible"],
    ["XX000", "operations_failed"],
  ]) {
    dbFailure = { code, message: "postgres://secret:secret@private-host/db SQL private" };
    response = await team.GET();
    const body = await response.text();
    check("erro seguro " + code, () => {
      assert.equal(response.status, code === "XX000" ? 500 : 503);
      assert.equal(JSON.parse(body).error, expected);
      assert.ok(!body.includes("secret"));
      assert.ok(!body.includes("private-host"));
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    });
  }
  dbFailure = null;
  check("conflito de nome continua sendo 409", () =>
    assert.equal(
      operationsErrorResponse({ code: "23505", message: "private" }, "test").status,
      409,
    ),
  );
  // O cliente usa a mensagem específica e não apresenta toda falha como migração.
  const client = load("src/lib/operations-client.ts");
  await assert.rejects(
    () => client.readOperationsResponse(Response.json(missing, { status: 503 })),
    (e) =>
      e.problem.error === "operations_schema_missing" &&
      e.problem.details.missingTables[0] === "company_teams",
  );
  count++;
  await assert.rejects(
    () => client.readOperationsResponse(new Response("<html>SQL secret</html>", { status: 500 })),
    (e) => !e.message.includes("secret") && !e.message.includes("migração"),
  );
  count++;
  await assert.rejects(
    () => client.readOperationsResponse(Response.json({ error: "forbidden" }, { status: 403 })),
    (e) => e.message.includes("permissão"),
  );
  count++;
  const clientSuccess = await client.readOperationsResponse(
    Response.json({ restrict_channels: true }),
  );
  check("resposta saudável de cliente preserva dados", () =>
    assert.equal(clientSuccess.restrict_channels, true),
  );
  let resource = { data: null, problem: missing, loading: false, reload() {} };
  const uiLoad = tsLoader({
    ...overrides,
    "@/lib/auth": {
      useAuth: () => ({
        user: { role: "ADMIN_EMPRESA" },
        companyId: a,
        companyName: "A",
        companyValid: true,
      }),
    },
    "@/lib/operations-client": { ...client, useOperationsData: () => resource },
  });
  const TeamPage = uiLoad("src/routes/_app.equipes-numeros.tsx").Route.component;
  let html = renderToStaticMarkup(React.createElement(TeamPage));
  check("tela de equipes bloqueia formulário e mostra tabela ausente", () => {
    assert.ok(html.includes('<fieldset disabled=""'));
    assert.ok(html.includes("company_teams"));
    assert.ok(html.includes("Tentar novamente"));
  });
  const SettingsPage = uiLoad("src/routes/_app.configuracoes.tsx").Route.component;
  html = renderToStaticMarkup(React.createElement(SettingsPage));
  check("tela de configurações bloqueia salvar quando falha", () =>
    assert.ok(html.includes('<fieldset disabled=""')),
  );
  resource = {
    data: { users: [], channels: [], teams: [], members: [], grants: [] },
    problem: null,
    loading: false,
    reload() {},
  };
  html = renderToStaticMarkup(React.createElement(TeamPage));
  check("tela saudável sem equipes permite cadastro", () =>
    assert.ok(!html.includes('<fieldset disabled=""')),
  );
  console.log(
    `PASS ${count} cenários de prontidão/erro/UI em banco isolado; nenhuma alteração em banco real.`,
  );
} finally {
  await pg.close();
}
