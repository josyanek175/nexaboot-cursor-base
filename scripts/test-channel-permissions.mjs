import assert from "node:assert/strict";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
try {
  const [{ id: a }] = await db`INSERT INTO companies(name) VALUES('A') RETURNING id`;
  const [{ id: b }] = await db`INSERT INTO companies(name) VALUES('B') RETURNING id`;
  const [{ id: u }] =
    await db`INSERT INTO users(company_id,name,role) VALUES(${a}::uuid,'Operador','ATENDENTE') RETURNING id`;
  const [{ id: foreign }] =
    await db`INSERT INTO users(company_id,name,role) VALUES(${b}::uuid,'Outro','ATENDENTE') RETURNING id`;
  const [{ id: x }] =
    await db`INSERT INTO whatsapp_channels(company_id,name) VALUES(${a}::uuid,'X') RETURNING id`;
  const [{ id: y }] =
    await db`INSERT INTO whatsapp_channels(company_id,name) VALUES(${a}::uuid,'Y') RETURNING id`;
  const [{ id: z }] =
    await db`INSERT INTO whatsapp_channels(company_id,name) VALUES(${b}::uuid,'Z') RETURNING id`;
  const [{ id: t }] =
    await db`INSERT INTO company_teams(company_id,name) VALUES(${a}::uuid,'Equipe') RETURNING id`;
  let role = "ADMIN_EMPRESA";
  const load = tsLoader({
    "@/lib/pg.server": { getSql: () => db, sql: db },
    "@/lib/session.server": { getSessionUserId: () => u },
    "@/lib/company.server": {
      requireCompanyId: async () => a,
      getCurrentUserCompanyInfo: async () => ({ userId: u, role, companyId: a }),
    },
  });
  const access = load("src/lib/channel-permissions.server.ts");
  const teams = load("src/lib/team-access.server.ts");
  assert.equal(await access.allowedChannelIds(a), null);
  await db`INSERT INTO company_operations_settings(company_id,restrict_channels) VALUES(${a}::uuid,true)`;
  assert.deepEqual(await access.allowedChannelIds(a), []);
  assert.equal((await access.requireChannelAccess(a, x)).status, 403);
  assert.equal((await access.requireChannelAccess(a, z)).status, 404);
  assert.equal(
    (await teams.saveTeamAction(a, { action: "grant", userId: foreign, channelId: x })).status,
    403,
  );
  assert.equal(
    (await teams.saveTeamAction(a, { action: "grant", userId: u, channelId: z })).status,
    403,
  );
  await teams.saveTeamAction(a, { action: "grant", userId: u, channelId: x });
  await teams.saveTeamAction(a, { action: "member", teamId: t, userId: u });
  await teams.saveTeamAction(a, { action: "grant", teamId: t, channelId: y });
  assert.deepEqual((await access.allowedChannelIds(a)).sort(), [x, y].sort());
  assert.equal(await access.requireChannelAccess(a, y), null);
  await teams.saveTeamAction(a, { action: "remove_member", teamId: t, userId: u });
  assert.deepEqual(await access.allowedChannelIds(a), [x]);
  await db`UPDATE users SET active=false WHERE id=${u}::uuid`;
  assert.deepEqual(await access.allowedChannelIds(a), []);
  await db`UPDATE users SET active=true,role='ADMIN_EMPRESA' WHERE id=${u}::uuid`;
  assert.equal(await access.allowedChannelIds(a), null);
  assert.deepEqual(await access.allowedChannelIds(b), []);
  await db`DELETE FROM company_channel_grants WHERE user_id=${u}::uuid`;
  await db`UPDATE users SET company_id=null,role='TI' WHERE id=${u}::uuid`;
  assert.equal(await access.allowedChannelIds(a), null);
  assert.equal(await access.allowedChannelIds(b), null);
  role = "ATENDENTE";
  assert.equal((await teams.requireTeamManager()).status, 403);
  role = "GERENTE";
  assert.equal((await teams.requireTeamManager()).companyId, a);
  // Composite database constraints reject cross-company grants even outside the handler.
  await assert.rejects(
    Promise.resolve(
      db`INSERT INTO company_channel_grants(company_id,channel_id,user_id) VALUES(${a}::uuid,${z}::uuid,${foreign}::uuid)`,
    ),
    (e) => e.code === "23503",
  );
  assert.equal(
    teams.TeamAction.safeParse({ action: "grant", channelId: x, userId: u, teamId: t }).success,
    false,
  );
  console.log(
    "PASS: isolated PostgreSQL — individual/team union, revocation, inactive users, admin/TI access and cross-company API/database rejection.",
  );
} finally {
  await pg.close();
}
