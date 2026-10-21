import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import postgres from "postgres";

const url = new URL(process.env.WORKSPACE_TEST_DATABASE_URL ?? "");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
assert.match(url.pathname, /_test$/);
const db = postgres(url.toString(), { max: 2, onnotice() {} });
globalThis.__workspaceTest = { db, token: null, fetches: [] };
const mocks = {
  "pg.server": `export const getSql=()=>globalThis.__workspaceTest.db;export function sql(s,...v){return s?globalThis.__workspaceTest.db(s,...v):globalThis.__workspaceTest.db};export const ensureCrmSchema=async()=>{};`,
  "@tanstack/react-start/server": `export const getCookie=()=>globalThis.__workspaceTest.token;export const setCookie=()=>{};export const deleteCookie=()=>{};`,
  "@tanstack/react-router": `export const createFileRoute=()=>o=>o;`,
  "operational-company.server": `export const getOperationalCompanyIdFromCookie=()=>null;`,
  "meta-access-token.server": `export const loadMetaAccessToken=async()=>'fake-local-token';`,
  "perf-diag.server": `export const withApiTiming=async(o,fn)=>fn({timedDb:async(n,query)=>query(),setResultCount:()=>{}});`,
};
const built = await build({
  stdin: {
    contents: `
 export * from './src/lib/workspace-path';export {normalizeAuthUser} from './src/lib/auth-user';
 export * from './src/lib/workspace-access.server';
 export * from './src/lib/whatsapp/interactive-message';
 export { MetaWhatsAppProvider } from './src/lib/whatsapp/providers/meta-whatsapp-provider.server';
 export { Route as workspaceRoute } from './src/routes/api/companies/$id/workspace';
 export { Route as historyRoute } from './src/routes/api/conversations/$id/messages';
 export { Route as mediaRoute } from './src/routes/api/messages/$messageId/media';
 export {Route as usersRoute} from './src/routes/api/users';
 export {Route as userRoute} from './src/routes/api/users/$id';
 `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  tsconfig: "tsconfig.json",
  plugins: [
    {
      name: "local-boundaries",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          const name = args.path.replace(/^@\/lib\//, "");
          if (name in mocks) return { path: name, namespace: "mock" };
        });
        b.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
          contents: mocks[args.path],
          loader: "js",
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const api = module.exports;
let checks = 0;
async function check(name, fn) {
  await fn();
  process.stdout.write(`PASS ${++checks}: ${name}\n`);
}
const a = randomUUID(),
  b = randomUUID(),
  u = randomUUID(),
  v = randomUUID(),
  channel = randomUUID(),
  contact = randomUUID(),
  conv = randomUUID(),
  old = randomUUID(),
  foreign = randomUUID();
const token = "local-workspace-token";
const req = (path, cookie = token) =>
  new Request("http://localhost:55474" + path, {
    headers: cookie ? { cookie: "nexa_session=" + cookie } : {},
  });
try {
  assert.equal((await db`SELECT to_regclass('public.companies') AS existing`)[0].existing, null);
  await db.unsafe(`CREATE TABLE companies(id uuid primary key,name text,active boolean default true,slug text,updated_at timestamptz default now());
 CREATE UNIQUE INDEX companies_slug ON companies(lower(slug)) WHERE slug IS NOT NULL;
 CREATE TABLE users(id uuid primary key,role text,company_id uuid,active boolean default true,email text,name text,tenant_id text DEFAULT 'default');
 CREATE TABLE user_sessions(id uuid default gen_random_uuid(),token_hash text,user_id uuid,company_id uuid,expires_at timestamptz,revoked_at timestamptz,revoked_reason text);
 CREATE TABLE conversations(id uuid primary key,company_id uuid,contact_id uuid,whatsapp_channel_id uuid);
 CREATE TABLE messages(id uuid default gen_random_uuid(),conversation_id uuid,external_id text,external_message_id text,direction text,message_type text,media_type text,message_text text,media_base64 text,media_url text,media_error text,mime_type text,media_mimetype text,media_filename text,media_seconds int,media_size int,media_caption text,from_me boolean,status text,created_at timestamptz default now(),sent_by_user_id uuid,sent_by_name text,reaction_emoji text,reaction_to_message_id text,raw_payload jsonb);`);
  await db`INSERT INTO companies(id,name,slug) VALUES (${a},'Empresa A','empresa1'),(${b},'Empresa B','empresa2')`;
  await db`INSERT INTO users(id,role,company_id) VALUES (${u},'ADMIN_EMPRESA',${a}),(${v},'ATENDENTE',${b})`;
  await db`INSERT INTO user_sessions(token_hash,user_id,company_id,expires_at) VALUES (${createHash("sha256").update(token).digest("hex")},${u},${a},now()+interval '1 day')`;
  globalThis.__workspaceTest.token = token;
  await check("URL da própria empresa aceita", async () =>
    assert.equal(await api.workspaceAccessResponse(req("/empresa1/atendimento")), null),
  );
  await check("URL de outra empresa bloqueada", async () =>
    assert.equal((await api.workspaceAccessResponse(req("/empresa2/atendimento"))).status, 403),
  );
  await check("ambiente inexistente retorna 404", async () =>
    assert.equal((await api.workspaceAccessResponse(req("/inexistente"))).status, 404),
  );
  await check("visitante pode chegar ao login sem acesso a dados", async () =>
    assert.equal(await api.workspaceAccessResponse(req("/empresa1", null)), null),
  );
  await check("empresa suspensa não abre", async () => {
    await db`UPDATE companies SET active=false WHERE id=${b}`;
    assert.equal((await api.workspaceAccessResponse(req("/empresa2"))).status, 404);
    await db`UPDATE companies SET active=true WHERE id=${b}`;
  });
  await check("API originada de URL de outra empresa é bloqueada", async () => {
    const r = new Request("http://localhost:55474/api/contacts", {
      headers: {
        cookie: "nexa_session=" + token,
        referer: "http://localhost:55474/empresa2/atendimento",
      },
    });
    assert.equal((await api.workspaceAccessResponse(r)).status, 403);
  });
  await check("rotas existentes nunca viram slug de empresa", async () => {
    for (const p of [
      "dashboard",
      "fluxos",
      "campanhas",
      "politica-de-privacidade",
      "termos-de-uso",
      "api",
    ])
      assert.equal(api.workspaceFromPath("/" + p), null);
  });
  await check("slug reservado, caracteres e tamanho são rejeitados", async () => {
    for (const slug of ["login", "Empresa1", "../outra", "a", "a".repeat(49)])
      assert.equal(api.validWorkspaceSlug(slug), false);
  });
  await check("rewrite mantém a empresa na navegação", async () => {
    const w = api.workspaceRewrite();
    assert.equal(
      w.input({ url: new URL("http://localhost/empresa1/atendimento") }).pathname,
      "/atendimento",
    );
    assert.equal(
      w.output({ url: new URL("http://localhost/dashboard") }).pathname,
      "/empresa1/dashboard",
    );
  });
  await check("routers independentes não compartilham empresa", async () => {
    const w = api.workspaceRewrite();
    assert.equal(w.output({ url: new URL("http://localhost/dashboard") }).pathname, "/dashboard");
  });
  const put = (id, slug) =>
    api.workspaceRoute.server.handlers.PUT({
      params: { id },
      request: new Request("http://localhost/api/companies/" + id + "/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      }),
    });
  await check("administrador de empresa não configura outra empresa", async () =>
    assert.equal((await put(b, "roubado")).status, 403),
  );
  await check("endereço exclusivo não pode ser repetido", async () =>
    assert.equal((await put(a, "empresa2")).status, 409),
  );
  await check("administrador configura seu próprio endereço", async () => {
    assert.equal((await put(a, "minha-loja")).status, 200);
    await put(a, "empresa1");
  });
  await check("atendente não altera endereço", async () => {
    await db`UPDATE users SET role='ATENDENTE' WHERE id=${u}`;
    assert.equal((await put(a, "outro")).status, 403);
    await db`UPDATE users SET role='ADMIN_EMPRESA' WHERE id=${u}`;
  });
  await check("sessão revogada perde acesso de configuração", async () => {
    await db`UPDATE user_sessions SET revoked_at=now()`;
    assert.equal((await put(a, "outro")).status, 401);
    await db`UPDATE user_sessions SET revoked_at=null`;
  });
  await db`INSERT INTO conversations(id,company_id,contact_id,whatsapp_channel_id) VALUES (${conv},${a},${contact},${channel}),(${old},${a},${contact},${channel}),(${foreign},${b},${contact},${channel})`;
  await db`INSERT INTO messages(conversation_id,message_text,direction,message_type,raw_payload) VALUES (${conv},'atual','in','text','{}'),(${old},'histórico anterior','in','text','{}'),(${foreign},'segredo empresa B','in','text','{}')`;
  const history = (id) =>
    api.historyRoute.server.handlers.GET({
      params: { id },
      request: new Request("http://localhost/api/conversations/" + id + "/messages"),
    });
  await check("históricos antigos e novos aparecem juntos", async () => {
    const data = await (await history(conv)).json();
    assert.equal(data.messages.length, 2);
    assert.deepEqual(data.messages.map((m) => m.body).sort(), ["atual", "histórico anterior"]);
  });
  await check("troca de ID não revela mensagens de outra empresa", async () =>
    assert.equal((await history(foreign)).status, 404),
  );
  await check("histórico continua paginado", async () => {
    const response = await api.historyRoute.server.handlers.GET({
      params: { id: conv },
      request: new Request("http://localhost/api/conversations/" + conv + "/messages?limit=1"),
    });
    assert.equal((await response.json()).messages.length, 1);
  });
  await check("cursor com data inválida retorna erro controlado", async () => {
    const result = await api.historyRoute.server.handlers.GET({
      params: { id: conv },
      request: new Request(
        "http://localhost/api/conversations/" + conv + "/messages?before=invalido",
      ),
    });
    assert.equal(result.status, 400);
  });
  await check("paginação não perde mensagens com horário idêntico", async () => {
    await db`UPDATE messages SET created_at='2026-10-21T12:00:00Z' WHERE conversation_id IN (${conv},${old})`;
    const first = await (
      await api.historyRoute.server.handlers.GET({
        params: { id: conv },
        request: new Request("http://localhost/api/conversations/" + conv + "/messages?limit=1"),
      })
    ).json();
    const m = first.messages[0];
    const next = await (
      await api.historyRoute.server.handlers.GET({
        params: { id: conv },
        request: new Request(
          "http://localhost/api/conversations/" +
            conv +
            "/messages?limit=1&before=" +
            encodeURIComponent(m.created_at) +
            "&before_id=" +
            m.id,
        ),
      })
    ).json();
    assert.equal(next.messages.length, 1);
    assert.notEqual(next.messages[0].id, m.id);
  });
  await check("histórico de outro canal da mesma empresa não se mistura", async () => {
    const another = randomUUID();
    await db`INSERT INTO conversations(id,company_id,contact_id,whatsapp_channel_id) VALUES (${another},${a},${contact},${randomUUID()})`;
    await db`INSERT INTO messages(conversation_id,message_text,direction,message_type) VALUES (${another},'Outro canal','in','text')`;
    assert.equal((await (await history(conv)).json()).messages.length, 2);
  });
  await check("cursor preserva os microssegundos do banco", async () => {
    await db`UPDATE messages SET created_at='2026-10-21T12:00:00.123001Z' WHERE conversation_id=${conv}`;
    await db`UPDATE messages SET created_at='2026-10-21T12:00:00.123002Z' WHERE conversation_id=${old}`;
    const first = await (
      await api.historyRoute.server.handlers.GET({
        params: { id: conv },
        request: new Request("http://localhost/api/conversations/" + conv + "/messages?limit=1"),
      })
    ).json();
    const c = first.nextCursor;
    assert.match(c.before, /123002Z$/);
    const next = await (
      await api.historyRoute.server.handlers.GET({
        params: { id: conv },
        request: new Request(
          "http://localhost/api/conversations/" +
            conv +
            "/messages?limit=1&before=" +
            encodeURIComponent(c.before) +
            "&before_id=" +
            c.id,
        ),
      })
    ).json();
    assert.equal(next.messages.length, 1);
    assert.notEqual(next.messages[0].id, first.messages[0].id);
  });
  await check("mídia de outra empresa é bloqueada por ID", async () => {
    const m = (await db`SELECT id FROM messages WHERE conversation_id=${foreign}`)[0];
    const result = await api.mediaRoute.server.handlers.GET({ params: { messageId: m.id } });
    assert.equal(result.status, 404);
  });
  await check("mídia legada funciona sem colunas do novo storage e não fica no cache", async () => {
    const m = (await db`SELECT id FROM messages WHERE conversation_id=${conv}`)[0];
    await db`UPDATE messages SET media_base64='aGk=',mime_type='text/plain' WHERE id=${m.id}`;
    const result = await api.mediaRoute.server.handlers.GET({ params: { messageId: m.id } });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), "hi");
    assert.match(result.headers.get("cache-control"), /no-store/);
  });
  await check(
    "empresas com tenant legado compartilhado continuam isoladas no cliente",
    async () => {
      const base = {
        id: u,
        email: "teste@example.invalid",
        name: "Teste",
        role: "ADMIN_EMPRESA",
        tenant_id: "default",
        company_valid: true,
      };
      const aUser = api.normalizeAuthUser({ ...base, company_id: a });
      const bUser = api.normalizeAuthUser({ ...base, company_id: b });
      assert.equal(aUser.tenantId, a);
      assert.equal(bUser.tenantId, b);
      assert.notEqual(aUser.tenantId, bUser.tenantId);
    },
  );
  await check("administrador de empresa não cria perfil TI ou SUPER_ADMIN", async () => {
    for (const role of ["TI", "SUPER_ADMIN", "ADMIN_GERAL"]) {
      const response = await api.usersRoute.server.handlers.POST({
        request: new Request("http://localhost/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Tentativa",
            email: "teste@example.invalid",
            password: "somente-teste",
            role,
          }),
        }),
      });
      assert.equal(response.status, 403);
    }
  });
  await check("administrador de empresa não promove a própria conta para plataforma", async () => {
    const result = await api.userRoute.server.handlers.PUT({
      params: { id: u },
      request: new Request("http://localhost/api/users/" + u, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "TI" }),
      }),
    });
    assert.equal(result.status, 403);
    assert.equal((await db`SELECT role FROM users WHERE id=${u}`)[0].role, "ADMIN_EMPRESA");
  });
  await check("trocar ID não permite editar usuário de outra empresa", async () => {
    const result = await api.userRoute.server.handlers.PUT({
      params: { id: v },
      request: new Request("http://localhost/api/users/" + v, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Invadido" }),
      }),
    });
    assert.equal(result.status, 404);
  });
  await check("administrador de empresa não redefine senha de perfil de plataforma", async () => {
    const platform = randomUUID();
    await db`INSERT INTO users(id,role,company_id) VALUES (${platform},'TI',${a})`;
    const result = await api.userRoute.server.handlers.PUT({
      params: { id: platform },
      request: new Request("http://localhost/api/users/" + platform, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "tentativa-local" }),
      }),
    });
    assert.equal(result.status, 403);
  });
  const originalFetch = globalThis.fetch;
  try {
    let sent;
    globalThis.fetch = async (url, options) => {
      sent = JSON.parse(options.body);
      globalThis.__workspaceTest.fetches.push(sent);
      return new Response(JSON.stringify({ messages: [{ id: "fake-wamid" }] }), { status: 200 });
    };
    const provider = new api.MetaWhatsAppProvider();
    const ch = { id: channel, companyId: a, phoneNumberId: "12345" };
    const buttons = [
      { id: "comprar", title: "Quero comprar" },
      { id: "assistencia", title: "Assistência" },
      { id: "outros", title: "Outros assuntos" },
    ];
    await check("provedor real gera três botões interativos Meta", async () => {
      assert.equal(
        (await provider.sendText(ch, "5511999999999", "Como ajudar?", buttons)).ok,
        true,
      );
      assert.equal(sent.type, "interactive");
      assert.equal(sent.interactive.action.buttons.length, 3);
      assert.deepEqual(sent.interactive.action.buttons[1].reply, buttons[1]);
    });
    await check("texto manual permanece mensagem de texto", async () => {
      await provider.sendText(ch, "5511999999999", "Mensagem manual");
      assert.equal(sent.type, "text");
    });
    await check("limite de botão é validado antes de chamar Meta", async () => {
      const n = globalThis.__workspaceTest.fetches.length;
      assert.equal(
        (await provider.sendText(ch, "5511999999999", "Menu", [{ id: "x", title: "x".repeat(21) }]))
          .ok,
        false,
      );
      assert.equal(globalThis.__workspaceTest.fetches.length, n);
    });
    await check("IDs repetidos e quatro botões são rejeitados", async () => {
      assert.throws(() => api.metaMessageContent("Menu", [buttons[0], buttons[0]]));
      assert.throws(() => api.metaMessageContent("Menu", [...buttons, buttons[0]]));
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  process.stdout.write(`RESULT: ${checks} workspace, history and native-button checks passed.\n`);
} finally {
  await db.end();
  delete globalThis.__workspaceTest;
}
