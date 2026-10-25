import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isolatedPostgres} from './test-support/isolated-postgres.mjs';
const {pg,db}=await isolatedPostgres();
try{
  const [{id:company}]=await db`INSERT INTO companies(name) VALUES('Preservada') RETURNING id`;
  const [{id:user}]=await db`INSERT INTO users(name,password_hash,company_id) VALUES('Preservado','unchanged',${company}::uuid) RETURNING id`;
  await pg.exec(readFileSync('scripts/migrations/20261025_company_operations.sql','utf8'));
  const [row]=await db`SELECT name,password_hash,password_changed_at FROM users WHERE id=${user}::uuid`;
  assert.equal(row.name,'Preservado');assert.equal(row.password_hash,'unchanged');assert.equal(row.password_changed_at,null);
  assert.equal(Number((await db`SELECT count(*) AS n FROM companies`)[0].n),1);
  await db`UPDATE users SET password_hash='changed' WHERE id=${user}::uuid`;
  assert.ok((await db`SELECT password_changed_at FROM users WHERE id=${user}::uuid`)[0].password_changed_at);
  console.log('PASS: operations migration reruns without changing existing companies/users/passwords; revocation trigger works.');
}finally{await pg.close();}
