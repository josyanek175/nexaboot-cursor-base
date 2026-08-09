/**
 * Extração/decodificação de campo base64 em JSON **sem** carregar a string
 * inteira no heap. Lê o arquivo com ReadStream, localiza `"base64":"…"`,
 * decodifica em blocos alinhados a 4 caracteres e grava o binário.
 *
 * A API Evolution (`getBase64FromMediaMessage`) ainda entrega JSON com base64;
 * o corpo HTTP pode ir para disco por stream, mas o campo base64 no JSON é
 * inerentemente ~4/3 do arquivo. Esta rotina evita a segunda cópia integral
 * (string JS + Buffer.from(base64 completo)).
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PermanentMediaProcessingError,
  TemporaryMediaProcessingError,
} from "@/lib/webhook-media-core";

const FIELD_RE = /"(base64)"\s*:\s*"/i;

/**
 * Capacidade interna excedida — TEMPORÁRIO (não irrecuperável).
 * Permite reprocessar após aumentar WEBHOOK_MEDIA_MAX_BYTES.
 */
export class InternalCapacityExceededError extends TemporaryMediaProcessingError {
  constructor(maxBytes: number, detail?: string) {
    super(
      "internal_capacity_exceeded",
      detail ??
        `arquivo excede WEBHOOK_MEDIA_MAX_BYTES (${maxBytes}); job preservado para reprocessamento`,
    );
    this.name = "InternalCapacityExceededError";
  }
}

export async function streamDecodeJsonBase64FieldToFile(params: {
  jsonPath: string;
  outPath: string;
  maxDecodedBytes: number;
  /** Janela máxima de caracteres base64 mantidos antes do decode (default 64 KiB). */
  decodeCharWindow?: number;
}): Promise<{ sizeBytes: number; checksum: string; fieldFound: boolean }> {
  const windowChars = params.decodeCharWindow ?? 64 * 1024;
  await mkdir(dirname(params.outPath), { recursive: true });

  const hash = createHash("sha256");
  let sizeBytes = 0;
  let pending = "";
  let phase: "scan" | "value" | "done" = "scan";
  let scanBuf = "";
  const out = createWriteStream(params.outPath);

  const flushDecode = async (force = false) => {
    const take = force
      ? pending.length - (pending.length % 4)
      : pending.length >= windowChars
        ? pending.length - (pending.length % 4)
        : 0;
    if (take <= 0) return;
    const slice = pending.slice(0, take);
    pending = pending.slice(take);
    const buf = Buffer.from(slice, "base64");
    sizeBytes += buf.length;
    if (sizeBytes > params.maxDecodedBytes) {
      throw new InternalCapacityExceededError(params.maxDecodedBytes);
    }
    hash.update(buf);
    if (!out.write(buf)) {
      await new Promise<void>((resolve) => out.once("drain", resolve));
    }
  };

  try {
    for await (const chunk of createReadStream(params.jsonPath, { encoding: "utf8" })) {
      const text = typeof chunk === "string" ? chunk : String(chunk);
      if (phase === "done") break;

      if (phase === "scan") {
        scanBuf += text;
        // Mantém só o necessário para casar o padrão no limite do chunk.
        if (scanBuf.length > 256 * 1024) {
          scanBuf = scanBuf.slice(-8 * 1024);
        }
        const match = FIELD_RE.exec(scanBuf);
        if (!match) continue;
        const after = scanBuf.slice(match.index + match[0].length);
        phase = "value";
        scanBuf = "";
        for (const ch of after) {
          if (ch === '"') {
            phase = "done";
            break;
          }
          if (/\s/.test(ch)) continue;
          pending += ch;
        }
        await flushDecode(false);
        continue;
      }

      if (phase === "value") {
        for (const ch of text) {
          if (ch === '"') {
            phase = "done";
            break;
          }
          if (/\s/.test(ch)) continue;
          pending += ch;
          if (pending.length >= windowChars) await flushDecode(false);
        }
      }
    }

    if (phase !== "done" && phase !== "value") {
      // Tenta data.base64: já coberto pelo mesmo nome de campo.
      throw new PermanentMediaProcessingError(
        "evolution_missing_base64",
        "campo base64 não encontrado no JSON da Evolution",
      );
    }

    await flushDecode(true);
    if (pending.length > 0) {
      // padding final
      const padded = pending + "=".repeat((4 - (pending.length % 4)) % 4);
      const buf = Buffer.from(padded, "base64");
      sizeBytes += buf.length;
      if (sizeBytes > params.maxDecodedBytes) {
        throw new InternalCapacityExceededError(params.maxDecodedBytes);
      }
      hash.update(buf);
      if (!out.write(buf)) {
        await new Promise<void>((resolve) => out.once("drain", resolve));
      }
      pending = "";
    }

    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on("error", reject);
    });

    if (sizeBytes === 0) {
      throw new PermanentMediaProcessingError("evolution_empty_base64", "base64 decodificou vazio");
    }

    return { sizeBytes, checksum: hash.digest("hex"), fieldFound: true };
  } catch (e) {
    out.destroy();
    await unlink(params.outPath).catch(() => undefined);
    throw e;
  }
}

/** Lê só o prefixo do JSON para mimetype — sem carregar base64. */
export async function peekJsonMimeType(
  jsonPath: string,
  fallback: string | null,
): Promise<string> {
  const stream = createReadStream(jsonPath, { encoding: "utf8", start: 0, end: 64 * 1024 - 1 });
  let head = "";
  for await (const chunk of stream) {
    head += chunk;
    if (head.length >= 64 * 1024) break;
  }
  const m =
    /"(?:mimetype|mimeType|mime_type)"\s*:\s*"([^"]+)"/i.exec(head) ??
    /"data"\s*:\s*\{[^}]{0,2000}"(?:mimetype|mimeType)"\s*:\s*"([^"]+)"/i.exec(head);
  return m?.[1] ?? fallback ?? "application/octet-stream";
}
