import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
const sent = [];
let fail = false;
const env = { ...process.env };
Object.assign(process.env, {
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "test",
  SMTP_PASSWORD: "isolated-test",
  SMTP_FROM: "NexaBoot <no-reply@example.test>",
  APP_PUBLIC_URL: "https://app.example.test",
});
try {
  const mail = {
    createTransport: () => ({
      sendMail: async (m) => {
        if (fail) throw Error("simulated smtp failure");
        sent.push(m);
      },
      close: () => {},
    }),
  };
  const recovery = tsLoader({ "@/lib/pg.server": { getSql: () => db }, nodemailer: mail })(
    "src/lib/password-recovery.server.ts",
  );
  const oldHash = await bcrypt.hash("old-password", 4);
  const [{ id: user }] =
    await db`INSERT INTO users(name,email,password_hash,role) VALUES('User','user@example.test',${oldHash},'ATENDENTE') RETURNING id`;
  const response = await recovery.requestRecovery(" USER@example.test ");
  assert.deepEqual(await recovery.requestRecovery("unknown@example.test"), response);
  assert.equal(sent.length, 1);
  let token = sent[0].text.match(/#([a-f0-9]{64})/)[1];
  const [stored] =
    await db`SELECT token_hash,credential_hash FROM password_reset_tokens WHERE user_id=${user}::uuid`;
  assert.notEqual(stored.token_hash, token);
  assert.ok(!JSON.stringify(stored).includes(oldHash));
  assert.equal(await recovery.consumeRecovery(token + "x", "new-password-123"), false);
  assert.equal(await recovery.consumeRecovery(token, "short"), false);
  assert.equal(await recovery.consumeRecovery(token, "á".repeat(40)), false);
  assert.equal(await recovery.consumeRecovery(token, "new-password-123"), true);
  assert.equal(await recovery.consumeRecovery(token, "another-password"), false);
  assert.equal(
    await bcrypt.compare(
      "new-password-123",
      (await db`SELECT password_hash FROM users WHERE id=${user}::uuid`)[0].password_hash,
    ),
    true,
  );
  await recovery.requestRecovery("user@example.test");
  token = sent.at(-1).text.match(/#([a-f0-9]{64})/)[1];
  await db`UPDATE password_reset_tokens SET expires_at=now()-interval '1 second' WHERE used_at IS NULL`;
  assert.equal(await recovery.consumeRecovery(token, "new-password-456"), false);
  await recovery.requestRecovery("user@example.test");
  token = sent.at(-1).text.match(/#([a-f0-9]{64})/)[1];
  await db`UPDATE users SET password_hash=${await bcrypt.hash("admin-change", 4)} WHERE id=${user}::uuid`;
  assert.equal(await recovery.consumeRecovery(token, "new-password-789"), false);
  assert.equal(sent.length, 3);
  await recovery.requestRecovery("user@example.test");
  assert.equal(sent.length, 3);
  await db`UPDATE password_reset_tokens SET created_at=now()-interval '2 hours'`;
  fail = true;
  await recovery.requestRecovery("user@example.test");
  assert.equal(
    Number((await db`SELECT count(*) AS n FROM password_reset_tokens WHERE used_at IS NULL`)[0].n),
    0,
  );
  delete process.env.SMTP_PASSWORD;
  await assert.rejects(recovery.requestRecovery("user@example.test"));
  console.log(
    "PASS: isolated PostgreSQL + fake SMTP — real hash change, opaque tokens, expiry, single use, admin-change invalidation, rate cap, generic responses, delivery failure and missing config. No real email sent.",
  );
} finally {
  process.env = env;
  await pg.close();
}
