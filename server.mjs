// Entry de produção (Node server) para o NexaBoot no Easypanel/VM.
//
// Motivo: o build gera `dist/server/server.js` como um HANDLER SSR
// (export default { fetch }), que NÃO inicia um servidor HTTP. Este arquivo
// envolve esse handler em um http.Server real com listen(), serve os assets
// estáticos de `dist/client` e preserva múltiplos headers Set-Cookie.
//
// Start: node server.mjs   (escuta em PORT/HOST)
import http from "node:http";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, "dist", "client");

const PORT = Number(process.env.PORT || process.env.NITRO_PORT || 3000);
const HOST = process.env.HOST || process.env.NITRO_HOST || "0.0.0.0";

const MIME = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

// Importa o handler SSR gerado pelo build.
const mod = await import("./dist/server/server.js");
const handler = mod.default ?? mod;
if (!handler || typeof handler.fetch !== "function") {
  console.error("[NEXABOOT] dist/server/server.js não exporta um handler { fetch }.");
  process.exit(1);
}

function toWebRequest(req) {
  const host = req.headers.host || `${HOST}:${PORT}`;
  const url = `http://${host}${req.url}`;
  const method = req.method || "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
    else headers.set(k, v);
  }
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

async function sendWebResponse(res, webRes) {
  res.statusCode = webRes.status;
  // Set-Cookie precisa de tratamento especial: Headers.forEach junta múltiplos
  // valores numa única string separada por vírgula, o que quebra cookies.
  const setCookies =
    typeof webRes.headers.getSetCookie === "function" ? webRes.headers.getSetCookie() : [];
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (setCookies.length) res.setHeader("Set-Cookie", setCookies);

  if (webRes.body) {
    Readable.fromWeb(webRes.body).pipe(res);
  } else {
    const buf = Buffer.from(await webRes.arrayBuffer());
    res.end(buf);
  }
}

async function tryServeStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    return false;
  }
  if (urlPath === "/" || urlPath.includes("..")) return false; // "/" => SSR renderiza
  const filePath = path.join(CLIENT_DIR, urlPath);
  if (!filePath.startsWith(CLIENT_DIR)) return false; // path traversal guard
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.setHeader("Content-Length", st.size);
    if (ext !== ".html") {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (await tryServeStatic(req, res)) return;
    const webReq = toWebRequest(req);
    const webRes = await handler.fetch(webReq, {}, {});
    await sendWebResponse(res, webRes);
  } catch (err) {
    console.error("[NEXABOOT] erro ao processar requisição:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    res.end("Internal Server Error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[NEXABOOT] Node server ouvindo em http://${HOST}:${PORT} (NODE_ENV=${process.env.NODE_ENV})`);
});
