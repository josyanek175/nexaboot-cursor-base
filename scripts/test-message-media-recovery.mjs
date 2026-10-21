import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolveStoredMetaMedia } from "../src/lib/stored-meta-media.ts";
const result = await build({
  entryPoints: ["src/routes/api/messages/$messageId/media.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "fixture",
      setup(b) {
        const mocks = {
          "@tanstack/react-router": "export const createFileRoute=()=>x=>x;",
          "@/lib/pg.server": "export const sql=()=>globalThis.__mediaFixture.sql;",
          "@/lib/company.server":
            "export const requireCompanyId=()=>globalThis.__mediaFixture.company;",
          "@/lib/meta-media-download.server":
            "export const downloadMetaMedia=(p)=>globalThis.__mediaFixture.download(p);",
          "@/lib/whatsapp/whatsapp-provider-router.server":
            "export const loadChannelForCompany=(...p)=>globalThis.__mediaFixture.channel(...p);",
        };
        b.onResolve({ filter: /.*/ }, (args) =>
          args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: mocks[args.path],
          loader: "js",
        }));
      },
    },
  ],
});
const { Route } = await import(
  "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64")
);
const id = "10000000-0000-4000-8000-000000000001",
  tenant = "20000000-0000-4000-8000-000000000002";
let downloads = 0,
  updates = 0,
  queries = [];
const row = {
  id,
  media_base64: null,
  raw_payload: {
    field: "smb_message_echoes",
    message: { type: "image", image: { id: "12345", mime_type: "image/png" } },
  },
  whatsapp_channel_id: "channel",
};
function fixture(message = row) {
  downloads = 0;
  updates = 0;
  queries = [];
  globalThis.__mediaFixture = {
    company: tenant,
    sql: async (strings, ...values) => {
      queries.push({ text: strings.join("?"), values });
      if (strings.join("").includes("UPDATE")) {
        updates++;
        return [];
      }
      return message ? [{ ...message }] : [];
    },
    channel: async (channel, company) => {
      assert.equal(channel, "channel");
      assert.equal(company, tenant);
      return { id: channel, channelType: "meta", phoneNumberId: "555" };
    },
    download: async (p) => {
      downloads++;
      assert.equal(p.companyId, tenant);
      assert.equal(p.mediaId, "12345");
      return { ok: true, base64: "aGVsbG8=", mimeType: "image/png", fileSize: 5 };
    },
  };
}
async function get() {
  return Route.server.handlers.GET({ params: { messageId: id } });
}
fixture();
let response = await get();
assert.equal(response.status, 200);
assert.equal(await response.text(), "hello");
assert.equal(response.headers.get("Content-Type"), "image/png");
assert.equal(downloads, 1);
assert.equal(updates, 1);
assert.ok(queries.every((q) => q.values.includes(tenant)));
console.log("OK echo recuperado e cacheado com escopo de empresa");
fixture({ ...row, media_base64: "aGVsbG8=", mime_type: "image/jpeg" });
response = await get();
assert.equal(response.status, 200);
assert.equal(downloads, 0);
assert.equal(updates, 0);
console.log("OK imagem existente sem nova chamada Meta");
fixture(null);
assert.equal((await get()).status, 404);
assert.equal(downloads, 0);
console.log("OK mensagem de outra empresa/inexistente sem download");
fixture();
globalThis.__mediaFixture.company = new Response("unauthorized", { status: 401 });
assert.equal((await get()).status, 401);
assert.equal(queries.length, 0);
console.log("OK sessão ausente bloqueada");
fixture();
globalThis.__mediaFixture.channel = async () => null;
assert.equal((await get()).status, 404);
assert.equal(downloads, 0);
console.log("OK canal inacessível bloqueado");
fixture();
globalThis.__mediaFixture.download = async () => ({ ok: false, error: "expired" });
assert.equal((await get()).status, 404);
assert.equal(updates, 0);
console.log("OK mídia expirada não altera histórico");
fixture();
globalThis.__mediaFixture.download = async () => {
  throw Error("secret");
};
response = await get();
assert.equal(response.status, 404);
assert.ok(!(await response.text()).includes("secret"));
console.log("OK falha de rede controlada sem segredo");
for (const bad of [
  null,
  {},
  [],
  { message: { type: "text", text: { id: "12" } } },
  { meta_media_type: "image", meta_media_id: "https://evil.test" },
  { message: { type: "image", image: {} } },
])
  assert.equal(resolveStoredMetaMedia(bad), null);
assert.equal(
  resolveStoredMetaMedia({ meta_media_type: "image", meta_media_id: "12345" }).id,
  "12345",
);
console.log("OK payload legado e rejeição de URL arbitrária");
delete globalThis.__mediaFixture;
