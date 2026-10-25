import assert from "node:assert/strict";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
try {
  const [{ id: a }] = await db`INSERT INTO companies(name) VALUES('A') RETURNING id`;
  const [{ id: b }] = await db`INSERT INTO companies(name) VALUES('B') RETURNING id`;
  const [{ id: admin }] =
    await db`INSERT INTO users(company_id,name,role) VALUES(${a}::uuid,'Admin','ADMIN_EMPRESA') RETURNING id`;
  const [{ id: member }] =
    await db`INSERT INTO users(company_id,name,role) VALUES(${a}::uuid,'User','ATENDENTE') RETURNING id`;
  const [{ id: outside }] =
    await db`INSERT INTO users(company_id,name,role) VALUES(${b}::uuid,'Outro','ATENDENTE') RETURNING id`;
  let company = a,
    role = "ADMIN_EMPRESA",
    failMembers = false;
  const wrapped = (strings, ...values) => db(strings, ...values);
  wrapped.begin = (fn) =>
    db.begin((tx) =>
      fn((strings, ...values) => {
        if (failMembers && strings.join("").includes("INSERT INTO internal_chat_members"))
          throw Error("simulated_member_failure");
        return tx(strings, ...values);
      }),
    );
  const load = tsLoader({
    "@tanstack/react-router": { createFileRoute: () => (config) => config },
    "@/lib/pg.server": { sql: db, getSql: () => wrapped },
    "@/lib/session.server": { getSessionUserId: () => admin },
    "@/lib/company.server": {
      requireCompanyId: async () => company,
      getCurrentUserCompanyInfo: async () => ({ userId: admin, role, companyId: company }),
    },
  });
  const create = load("src/routes/api/internal-chat/create.ts").Route.server.handlers.POST;
  const groups = load("src/routes/api/internal-groups.ts").Route.server.handlers;
  const make = (ids, type = "group") =>
    create({
      request: new Request("https://example.test/api/internal-chat/create", {
        method: "POST",
        body: JSON.stringify({ type, title: "Equipe", memberIds: ids }),
      }),
    });
  assert.equal((await make([outside])).status, 403);
  role = "ATENDENTE";
  assert.equal((await make([member])).status, 403);
  role = "ADMIN_EMPRESA";
  failMembers = true;
  await assert.rejects(make([member]), /simulated_member_failure/);
  failMembers = false;
  assert.equal(Number((await db`SELECT count(*) AS n FROM internal_chats`)[0].n), 0);
  let result = await make([member]);
  assert.equal(result.status, 200);
  const { chat } = await result.json();
  assert.equal(
    Number(
      (await db`SELECT count(*) AS n FROM internal_chat_members WHERE chat_id=${chat.id}::uuid`)[0]
        .n,
    ),
    2,
  );
  assert.equal((await (await groups.GET()).json()).groups.length, 1);
  const patch = (members) =>
    groups.PATCH({
      request: new Request("https://example.test/api/internal-groups", {
        method: "PATCH",
        body: JSON.stringify({ id: chat.id, name: "Editado", active: false, memberIds: members }),
      }),
    });
  assert.equal((await patch([outside])).status, 403);
  assert.equal(
    (await db`SELECT name FROM internal_chats WHERE id=${chat.id}::uuid`)[0].name,
    "Equipe",
  );
  assert.equal((await patch([member])).status, 200);
  assert.equal(
    (await db`SELECT active FROM internal_chats WHERE id=${chat.id}::uuid`)[0].active,
    false,
  );
  company = b;
  assert.equal((await (await groups.GET()).json()).groups.length, 0);
  assert.equal((await patch([outside])).status, 404);
  company = a;
  const first = await (await make([member], "direct")).json();
  const second = await (await make([member], "direct")).json();
  assert.equal(first.chat.id, second.chat.id);
  assert.equal(second.reused, true);
  console.log(
    "PASS: isolated PostgreSQL — persistent groups, company/member/role isolation, transaction rollback, edit/deactivate and direct-chat reuse.",
  );
} finally {
  await pg.close();
}
