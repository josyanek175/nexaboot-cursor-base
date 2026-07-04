/**
 * Poller do worker de campanhas (dev/produção).
 *
 * Requer o app NexaBoot rodando (API /api/campaigns/worker/tick).
 *
 * Uso:
 *   node scripts/campaign-worker.mjs
 *
 * Env:
 *   APP_URL                 (default http://localhost:3000)
 *   CAMPAIGN_WORKER_SECRET  (obrigatório em produção)
 */

const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const SECRET = process.env.CAMPAIGN_WORKER_SECRET || "";
const IDLE_MS = Number(process.env.CAMPAIGN_WORKER_IDLE_MS || 5000);

function headers() {
  const h = { "Content-Type": "application/json" };
  if (SECRET) h["x-worker-secret"] = SECRET;
  return h;
}

async function tick() {
  const res = await fetch(`${APP_URL}/api/campaigns/worker/tick`, {
    method: "POST",
    headers: headers(),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: false, action: "error", delayMs: 10_000, message: text.slice(0, 200) };
  }
  if (!res.ok) {
    console.error("[campaign-worker] HTTP", res.status, data);
  } else if (data.action && data.action !== "idle") {
    console.log("[campaign-worker]", data);
  }
  return typeof data.delayMs === "number" && data.delayMs > 0 ? data.delayMs : IDLE_MS;
}

async function main() {
  console.log("[campaign-worker] start", { APP_URL, hasSecret: !!SECRET, IDLE_MS });
  for (;;) {
    let delay = IDLE_MS;
    try {
      delay = await tick();
    } catch (e) {
      console.error("[campaign-worker] tick error", e);
      delay = 10_000;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}

main();
