// Armazenamento de anexos da Comunicação Interna em DISCO/VOLUME do servidor.
// O banco guarda apenas metadados + caminho relativo (nunca base64).
// Escopo: somente chat interno. Não toca em WhatsApp/Evolution/CRM.
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, normalize, basename, extname, sep } from "node:path";
import { randomUUID } from "node:crypto";

/** Pasta persistente onde os anexos são gravados (volume no Easypanel). */
export function uploadDir(): string {
  return process.env.INTERNAL_UPLOAD_DIR || "/app/storage/internal-chat";
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// Tipos permitidos: extensão -> { mime aceitos, categoria }.
type Category = "image" | "document";

const ALLOWED: Record<string, { mimes: string[]; type: Category }> = {
  jpg: { mimes: ["image/jpeg"], type: "image" },
  jpeg: { mimes: ["image/jpeg"], type: "image" },
  png: { mimes: ["image/png"], type: "image" },
  webp: { mimes: ["image/webp"], type: "image" },
  pdf: { mimes: ["application/pdf"], type: "document" },
  doc: { mimes: ["application/msword"], type: "document" },
  docx: {
    mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    type: "document",
  },
  xls: { mimes: ["application/vnd.ms-excel"], type: "document" },
  xlsx: {
    mimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    type: "document",
  },
  txt: { mimes: ["text/plain"], type: "document" },
  csv: { mimes: ["text/csv", "application/csv"], type: "document" },
};

// Extensões explicitamente perigosas (bloqueio defensivo extra).
const BLOCKED = new Set([
  "exe", "bat", "sh", "js", "html", "htm", "php", "msi", "cmd", "scr",
  "com", "vbs", "ps1", "jar", "dll",
]);

export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED);
export const ALLOWED_ACCEPT =
  ".jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv";

function extOf(name: string): string {
  return extname(name).replace(/^\./, "").toLowerCase();
}

export interface SavedAttachment {
  /** Caminho relativo (basename) gravado no banco em attachment_path. */
  path: string;
  mimeType: string;
  /** Nome físico no disco (uuid + extensão). */
  filename: string;
  /** Nome original apenas para exibição/download. */
  originalName: string;
  size: number;
  type: Category;
}

export class UploadError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Sanitiza o nome original só para exibição (não é usado no disco). */
function safeOriginalName(name: string): string {
  const base = basename(name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "arquivo").slice(0, 200);
}

/**
 * Valida e grava o arquivo no volume. Gera nome físico com UUID; NÃO confia no
 * nome original para o caminho de disco. Lança UploadError em caso de rejeição.
 */
export async function saveInternalAttachment(file: File): Promise<SavedAttachment> {
  const originalName = safeOriginalName(file.name || "arquivo");
  const ext = extOf(originalName);

  if (!ext) throw new UploadError("missing_extension", "Arquivo sem extensão.");
  if (BLOCKED.has(ext)) throw new UploadError("blocked_type", `Tipo de arquivo não permitido: .${ext}`);
  const rule = ALLOWED[ext];
  if (!rule) throw new UploadError("unsupported_type", `Tipo de arquivo não suportado: .${ext}`);

  const size = file.size;
  if (size <= 0) throw new UploadError("empty_file", "Arquivo vazio.");
  if (size > MAX_UPLOAD_BYTES) {
    throw new UploadError("too_large", "Arquivo excede o limite de 10 MB.", 413);
  }

  // Confere o mime declarado quando presente (defensivo; extensão é a regra principal).
  const declaredMime = (file.type || "").toLowerCase();
  const mimeType = rule.mimes.includes(declaredMime) ? declaredMime : rule.mimes[0];

  const dir = uploadDir();
  await mkdir(dir, { recursive: true });

  const filename = `${randomUUID()}.${ext}`;
  const abs = join(dir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(abs, buffer);

  return {
    path: filename, // relativo ao uploadDir()
    mimeType,
    filename,
    originalName,
    size,
    type: rule.type,
  };
}

/**
 * Resolve o caminho absoluto de um anexo de forma segura (impede path traversal).
 * Retorna null se o caminho escapar do diretório de uploads.
 */
export function resolveAttachmentPath(storedPath: string): string | null {
  const dir = normalize(uploadDir());
  // Usa apenas o basename para nunca permitir subir diretórios.
  const safe = basename(normalize(storedPath));
  const abs = normalize(join(dir, safe));
  const dirWithSep = dir.endsWith(sep) ? dir : dir + sep;
  if (abs !== join(dir, safe) || !abs.startsWith(dirWithSep)) return null;
  return abs;
}

/** Lê o arquivo do disco como Buffer; null se não existir. */
export async function readAttachment(storedPath: string): Promise<Buffer | null> {
  const abs = resolveAttachmentPath(storedPath);
  if (!abs) return null;
  try {
    await stat(abs);
    return await readFile(abs);
  } catch {
    return null;
  }
}
