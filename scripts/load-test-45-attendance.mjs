/**
 * Benchmark / carga FASE 2 — 45 sessões simuladas.
 *
 * Uso:
 *   APP_URL=https://hml... \
 *   HML_PASSWORD='...' \
 *   SESSION_COOKIE_NAME=nexa_session \
 *   node scripts/load-test-45-attendance.mjs
 *
 * Mede: avg / p95 / p99 / erros / timeouts / duração total.
 * Pool: lê /api/health.poolMax (não consegue ver conexões PG sem DB).
 *
 * Webhooks: POST simulado opcional se EVOLUTION_WEBHOOK_SECRET + path públicos.
 */
const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const password = process.env.HML_PASSWORD || process.env.LOAD_TEST_PASSWORD || "";
const cookieName = process.env.SESSION_COOKIE_NAME || "nexa_session";
const concurrency = Number(process.env.LOAD_CONCURRENCY || 45);
const rounds = Number(process.env.LOAD_ROUNDS || 3);
const timeoutMs = Number(process.env.LOAD_TIMEOUT_MS || 15_000);

if (!password) {
  console.error("Defina HML_PASSWORD ou LOAD_TEST_PASSWORD");
  process.exit(1);
}

function emails() {
  const list = [];
  for (let i = 1; i <= concurrency; i++) {
    list.push(
      process.env[`LOAD_EMAIL_${i}`] ||
        `hml.user${String(i).padStart(2, "0")}@example.test`,
    );
  }
  // fallback: mesmo usuário N vezes se só LOAD_EMAIL definido
  if (process.env.LOAD_EMAIL) {
    return Array.from({ length: concurrency }, () => process.env.LOAD_EMAIL);
  }
  return list;
}

function pickCookie(res) {
  const lines = res.headers.getSetCookie?.() ?? [];
  const all = lines.length ? lines : [res.headers.get("set-cookie")].filter(Boolean);
  for (const line of all) {
    if (line?.startsWith(`${cookieName}=`)) return line.split(";")[0];
  }
  return null;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, rej) =>
        setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), timeoutMs),
      ),
    ]);
    return { ok: true, ms: Date.now() - t0, result };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: e?.code === "TIMEOUT" ? "timeout" : e?.message || String(e),
      timeout: e?.code === "TIMEOUT",
    };
  }
}

async function login(email) {
  return timed(async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status >= 500) throw new Error(`login_${res.status}`);
    const cookie = pickCookie(res);
    if (!cookie) throw new Error(`no_cookie_${res.status}`);
    return { cookie, body };
  });
}

async function getJson(path, cookie) {
  return timed(async () => {
    const res = await fetch(`${base}${path}`, { headers: { cookie } });
    const body = await res.json().catch(() => ({}));
    if (res.status >= 500) throw new Error(`http_${res.status}`);
    if (body?.error === "auth_context_timeout") throw new Error("auth_context_timeout");
    return { status: res.status, body };
  });
}

function summarize(label, samples) {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const ok = samples.filter((s) => s.ok).length;
  const errors = samples.filter((s) => !s.ok && !s.timeout).length;
  const timeouts = samples.filter((s) => s.timeout).length;
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  return {
    label,
    n: samples.length,
    ok,
    errors,
    timeouts,
    avgMs: avg,
    p95Ms: percentile(times, 95),
    p99Ms: percentile(times, 99),
    maxMs: times.length ? times[times.length - 1] : null,
  };
}

async function main() {
  console.log("[LOAD_START]", { base, concurrency, rounds, cookieName });

  const health = await getJson("/api/health", "");
  console.log("[HEALTH]", {
    ok: health.ok,
    poolMax: health.result?.body?.poolMax,
    bootstrapEnabled: health.result?.body?.bootstrapEnabled,
    databaseBootstrap: health.result?.body?.databaseBootstrap,
  });

  const list = emails().slice(0, concurrency);
  const sessions = [];
  const loginSamples = [];

  // Login paralelo
  const loginResults = await Promise.all(list.map((email) => login(email).then((r) => ({ email, ...r }))));
  for (const r of loginResults) {
    loginSamples.push(r);
    if (r.ok && r.result?.cookie) sessions.push({ email: r.email, cookie: r.result.cookie });
  }
  console.log("[LOGIN]", summarize("login", loginSamples));

  if (sessions.length === 0) {
    console.error("Nenhuma sessão autenticada — abort");
    process.exit(1);
  }

  const convListSamples = [];
  const openSamples = [];
  const pollSamples = [];
  const webhookSamples = [];

  for (let round = 0; round < rounds; round++) {
    // Lista de conversas (45 em paralelo)
    const lists = await Promise.all(
      sessions.map((s) =>
        getJson("/api/conversations?limit=100", s.cookie).then((r) => ({ ...r, cookie: s.cookie })),
      ),
    );
    for (const r of lists) convListSamples.push(r);

    // Abrir primeira conversa de cada sessão
    const opens = await Promise.all(
      lists.map(async (r) => {
        if (!r.ok) return r;
        const convs = r.result?.body?.conversations ?? [];
        const id = convs[0]?.id;
        if (!id) return { ok: true, ms: 0, skipped: true };
        return getJson(`/api/conversations/${id}/messages?limit=100`, r.cookie);
      }),
    );
    for (const r of opens) if (!r.skipped) openSamples.push(r);

    // Polling simultâneo (2ª passagem lista + msgs)
    const polls = await Promise.all(
      sessions.map(async (s) => {
        const a = await getJson("/api/conversations?limit=100", s.cookie);
        if (!a.ok) return a;
        const id = a.result?.body?.conversations?.[0]?.id;
        if (!id) return a;
        return getJson(`/api/conversations/${id}/messages?limit=100`, s.cookie);
      }),
    );
    for (const r of polls) pollSamples.push(r);
  }

  // Webhook simulado (opcional)
  const evoSecret = process.env.EVOLUTION_WEBHOOK_SECRET;
  if (evoSecret) {
    for (let i = 0; i < Math.min(10, concurrency); i++) {
      const r = await timed(async () => {
        const res = await fetch(`${base}/api/public/webhooks/evolution`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-webhook-secret": evoSecret,
          },
          body: JSON.stringify({
            event: "connection.update",
            instance: "load-test-nonexistent",
            data: { state: "open" },
          }),
        });
        // 404 channel not found ainda conta como pipeline OK (não 500)
        if (res.status >= 500) throw new Error(`webhook_${res.status}`);
        return { status: res.status };
      });
      webhookSamples.push(r);
    }
  }

  const report = {
    login: summarize("login", loginSamples),
    conversationsList: summarize("conversations", convListSamples),
    openConversation: summarize("messages", openSamples),
    polling: summarize("polling", pollSamples),
    webhooks: webhookSamples.length ? summarize("webhooks", webhookSamples) : null,
    sessionsOk: sessions.length,
    poolMaxHint: health.result?.body?.poolMax ?? null,
    note:
      "Confirme max_connections no PostgreSQL e (#replicas * PG_POOL_MAX + workers) antes de fixar PG_POOL_MAX=20.",
  };

  console.log("[LOAD_REPORT]");
  console.log(JSON.stringify(report, null, 2));

  const critical =
    report.login.timeouts > 0 ||
    report.conversationsList.timeouts > 0 ||
    report.conversationsList.errors > sessions.length ||
    report.openConversation.errors > sessions.length;

  if (critical) {
    console.error("[LOAD_FAIL] timeouts ou erros excessivos");
    process.exit(1);
  }
  console.log("[LOAD_PASSED]");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
