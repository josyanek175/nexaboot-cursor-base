import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// postgres queries are lazy thenables. Awaiting a correlated fragment executes
// it without its outer company alias. This double preserves that behavior.
for (const hasDeletedAt of [true, false]) {
  const executed = [];
  const companyId = "22222222-2222-4222-8222-222222222222";
  const rows = [{ id: companyId, name: "Empresa criada", active_users: 1, whatsapp_channels_used: 0 }];
  const fragment = Symbol("fragment");
  function db(strings, ...values) {
    const query = {
      [fragment]: true,
      text: strings.reduce((text, part, i) => text + part + (i < values.length ? (values[i]?.[fragment] ? values[i].text : "?") : ""), ""),
      values,
      then(resolve, reject) {
        try {
          executed.push(query.text);
          if (query.text.includes("information_schema.columns")) return Promise.resolve(hasDeletedAt ? [{ exists: 1 }] : []).then(resolve, reject);
          assert.ok(query.text.includes("FROM public.companies c"), "Correlated channel fragment executed without its company query");
          assert.ok(query.text.includes("ch.company_id = c.id"));
          assert.equal(query.text.includes("ch.deleted_at IS NULL"), hasDeletedAt);
          assert.ok(!values.some(Array.isArray), "Query fragments cannot be replaced with executed result rows");
          return Promise.resolve(rows).then(resolve, reject);
        } catch (error) { return Promise.reject(error).then(resolve, reject); }
      },
    };
    return query;
  }
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync("src/lib/subscription.server.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "module", "exports", source)((name) => {
    assert.equal(name, "@/lib/pg.server");
    return { sql: db, getSql: () => db };
  }, module, module.exports);
  assert.deepEqual(await module.exports.listCompaniesWithPlanUsage({}), rows);
  assert.deepEqual(await module.exports.listCompaniesWithPlanUsage({ companyId }), rows);
  assert.equal(executed.length, 3, "One metadata read, then one query per listing");
  assert.ok(!executed[1].includes("WHERE c.id ="));
  assert.ok(executed[2].includes("WHERE c.id = ?::uuid"));
}
console.log("Company listing: correlated fragments remain lazy, global/company scope and legacy deleted_at variants passed. No database accessed.");
