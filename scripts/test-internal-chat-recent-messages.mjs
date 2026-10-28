import assert from "node:assert/strict";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
try {
  const [{ id: company }] = await db`INSERT INTO companies(name) VALUES('Empresa teste') RETURNING id`;
  const [{ id: user }] = await db`INSERT INTO users(company_id,name) VALUES(${company}::uuid,'Pessoa teste') RETURNING id`;
  const [{ id: chat }] = await db`INSERT INTO internal_chats(company_id,name,type) VALUES(${company}::uuid,'Conversa longa','group') RETURNING id`;
  await db`INSERT INTO internal_chat_members(chat_id,user_id) VALUES(${chat}::uuid,${user}::uuid)`;
  await db`INSERT INTO internal_messages(chat_id,sender_id,body,created_at)
    SELECT ${chat}::uuid,${user}::uuid,'Mensagem '||n,timestamptz '2026-01-01 00:00:00+00'+n*interval '1 second'
    FROM generate_series(1,650) AS n`;
  let actorCompany = company;
  const load = tsLoader({
    "@tanstack/react-router": { createFileRoute: () => config => config },
    "@/lib/pg.server": { sql: db },
    "@/lib/company.server": { requireCompanyId: async () => actorCompany },
    "@/lib/session.server": { getSessionUserId: () => user },
  });
  const { Route } = load("src/routes/api/internal-chat/messages.ts");
  const get = () => Route.server.handlers.GET({ request: new Request(`http://localhost/api/internal-chat/messages?chatId=${chat}`) });
  const response = await get();
  assert.equal(response.status, 200);
  const { messages } = await response.json();
  assert.equal(messages.length, 500);
  assert.equal(messages[0].body, 'Mensagem 151');
  assert.equal(messages.at(-1).body, 'Mensagem 650');
  assert.ok(messages.every((m,i) => i === 0 || new Date(m.created_at) >= new Date(messages[i-1].created_at)));
  assert.equal((await db`SELECT count(*)::int AS n FROM internal_messages`)[0].n, 650);
  assert.ok((await db`SELECT last_read_at FROM internal_chat_members WHERE chat_id=${chat}::uuid`)[0].last_read_at);
  const [{ id: otherCompany }] = await db`INSERT INTO companies(name) VALUES('Outra empresa') RETURNING id`;
  actorCompany = otherCompany;
  assert.equal((await get()).status, 403);
  console.log('PASS: 650 mensagens preservadas; últimas 500 em ordem cronológica, mensagem mais recente incluída, leitura registrada e acesso de outra empresa bloqueado.');
} finally {
  await pg.close();
}
