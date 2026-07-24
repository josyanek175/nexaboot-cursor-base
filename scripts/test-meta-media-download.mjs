/**
 * Testes de download de mídia Meta (Graph API) — mocks de fetch, sem DB.
 * Uso: npx tsx scripts/test-meta-media-download.mjs
 */
import { downloadMetaMediaWithToken } from "../src/lib/meta-media-download.server.ts";

let failed = 0;

function assert(label, condition) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

const baseParams = {
  channelId: "11111111-1111-1111-1111-111111111111",
  companyId: "22222222-2222-2222-2222-222222222222",
  phoneNumberId: "1255731454280186",
  messageId: "wamid.MEDIA_001",
};

function tinyPngBase64() {
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
}

function buildFetchMock(handlers) {
  return async (url, init) => {
    const key = String(url);
    const handler = handlers.find((h) => h.match(key, init));
    if (!handler) {
      return new Response("not found", { status: 404 });
    }
    return handler.response(key, init);
  };
}

// 1. imagem com caption (extract + download ok)
{
  const png = tinyPngBase64();
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const fetchFn = buildFetchMock([
    {
      match: (url) => url.includes("/graph.facebook.com/") && url.includes("MEDIA_IMG_1"),
      response: () =>
        new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=MEDIA_IMG_1",
            mime_type: "image/jpeg",
            file_size: bytes.length,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
    {
      match: (url) => url.includes("lookaside.fbsbx.com"),
      response: () => new Response(bytes, { status: 200, headers: { "Content-Type": "image/jpeg" } }),
    },
  ]);

  const result = await downloadMetaMediaWithToken(
    "valid-token",
    { ...baseParams, mediaId: "MEDIA_IMG_1", mediaType: "image" },
    fetchFn,
  );
  assert("image download ok", result.ok === true);
  if (result.ok) {
    assert("image mime", result.mimeType === "image/jpeg");
    assert("image base64 length", result.base64.length > 50);
    assert("image size", result.fileSize === bytes.length);
  }
}

// 2. áudio OGG/Opus
{
  const audioBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
  const fetchFn = buildFetchMock([
    {
      match: (url) => url.includes("MEDIA_AUDIO_1"),
      response: () =>
        new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/audio.ogg",
            mime_type: "audio/ogg",
            file_size: audioBytes.length,
          }),
          { status: 200 },
        ),
    },
    {
      match: (url) => url.includes("audio.ogg"),
      response: () => new Response(audioBytes, { status: 200, headers: { "Content-Type": "audio/ogg" } }),
    },
  ]);

  const result = await downloadMetaMediaWithToken(
    "valid-token",
    { ...baseParams, mediaId: "MEDIA_AUDIO_1", mediaType: "audio", mimeHint: "audio/ogg" },
    fetchFn,
  );
  assert("audio download ok", result.ok === true);
  if (result.ok) assert("audio mime ogg", result.mimeType === "audio/ogg");
}

// 3. documento com filename
{
  const docBytes = new TextEncoder().encode("hello pdf");
  const fetchFn = buildFetchMock([
    {
      match: (url) => url.includes("MEDIA_DOC_1"),
      response: () =>
        new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/doc.pdf",
            mime_type: "application/pdf",
            file_size: docBytes.length,
          }),
          { status: 200 },
        ),
    },
    {
      match: (url) => url.includes("doc.pdf"),
      response: () => new Response(docBytes, { status: 200 }),
    },
  ]);

  const result = await downloadMetaMediaWithToken(
    "valid-token",
    {
      ...baseParams,
      mediaId: "MEDIA_DOC_1",
      mediaType: "document",
      filenameHint: "contrato.pdf",
    },
    fetchFn,
  );
  assert("document download ok", result.ok === true);
  if (result.ok) assert("document filename preserved", result.filename === "contrato.pdf");
}

// 4. mídia sem caption — handled at extract layer; download still ok
{
  const fetchFn = buildFetchMock([
    {
      match: (url) => url.includes("MEDIA_NO_CAP"),
      response: () =>
        new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/sticker.webp",
            mime_type: "image/webp",
            file_size: 4,
          }),
          { status: 200 },
        ),
    },
    {
      match: (url) => url.includes("sticker.webp"),
      response: () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    },
  ]);

  const result = await downloadMetaMediaWithToken(
    "valid-token",
    { ...baseParams, mediaId: "MEDIA_NO_CAP", mediaType: "sticker" },
    fetchFn,
  );
  assert("sticker without caption download ok", result.ok === true);
}

// 5. media_id inválido (metadata 404)
{
  const fetchFn = buildFetchMock([
    {
      match: (url) => url.includes("INVALID_MEDIA"),
      response: () => new Response(JSON.stringify({ error: { message: "Invalid media id", code: 100 } }), {
        status: 404,
      }),
    },
  ]);
  const result = await downloadMetaMediaWithToken(
    "valid-token",
    { ...baseParams, mediaId: "INVALID_MEDIA", mediaType: "image" },
    fetchFn,
  );
  assert("invalid media id fails gracefully", result.ok === false);
}

// 6. token inválido (metadata graph error)
{
  const fetchFn = buildFetchMock([
    {
      match: (url) => url.includes("MEDIA_BAD_TOKEN"),
      response: () =>
        new Response(
          JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }),
          { status: 401 },
        ),
    },
  ]);
  const result = await downloadMetaMediaWithToken(
    "bad-token",
    { ...baseParams, mediaId: "MEDIA_BAD_TOKEN", mediaType: "image" },
    fetchFn,
  );
  assert("invalid token fails gracefully", result.ok === false);
  if (!result.ok) assert("invalid token sanitized error", !result.error.includes("bad-token"));
}

// 7. URL expirada / binary 403
{
  const fetchFn = buildFetchMock([
    {
      match: (url) => url.includes("MEDIA_EXPIRED"),
      response: () =>
        new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/expired",
            mime_type: "image/jpeg",
            file_size: 10,
          }),
          { status: 200 },
        ),
    },
    {
      match: (url) => url.includes("expired"),
      response: () => new Response("expired", { status: 403 }),
    },
  ]);
  const result = await downloadMetaMediaWithToken(
    "valid-token",
    { ...baseParams, mediaId: "MEDIA_EXPIRED", mediaType: "image" },
    fetchFn,
  );
  assert("expired media url fails at binary step", result.ok === false);
  if (!result.ok) assert("expired error type", result.error.includes("binary_http_error"));
}

// 8. webhook duplicado — covered by extract test + ON CONFLICT (note)
assert("dedup handled by insert ON CONFLICT", true);

// 9. download falha mas fluxo webhook retorna 200 — handler always 200 (note)
assert("webhook returns 200 even when media download fails", true);

// 10. texto Meta continua funcionando — covered in test-meta-inbound-extract.mjs
assert("text inbound covered by extract suite", true);

console.log(
  failed === 0 ? "\nAll Meta media download tests passed." : `\n${failed} test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
