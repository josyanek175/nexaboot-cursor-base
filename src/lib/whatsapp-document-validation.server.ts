// Validação de documentos outbound WhatsApp (Meta + Evolution).
// Nunca confiar apenas na extensão informada pelo navegador.

import { extname, basename } from "node:path";

export const WHATSAPP_DOCUMENT_EXTENSIONS = ["pdf", "doc", "docx", "xls", "xlsx"] as const;

export type WhatsAppDocumentExtension = (typeof WHATSAPP_DOCUMENT_EXTENSIONS)[number];

const EXT_RULES: Record<
  WhatsAppDocumentExtension,
  { mimes: string[]; mime: string }
> = {
  pdf: { mimes: ["application/pdf"], mime: "application/pdf" },
  doc: { mimes: ["application/msword"], mime: "application/msword" },
  docx: {
    mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  xls: { mimes: ["application/vnd.ms-excel"], mime: "application/vnd.ms-excel" },
  xlsx: {
    mimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
};

const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "bat",
  "sh",
  "js",
  "html",
  "htm",
  "php",
  "msi",
  "cmd",
  "scr",
  "com",
  "vbs",
  "ps1",
  "jar",
  "dll",
  "svg",
  "zip",
  "rar",
  "7z",
]);

export const WHATSAPP_DOCUMENT_ACCEPT =
  ".pdf,.doc,.docx,.xls,.xlsx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export function whatsappDocumentMaxBytes(): number {
  const raw = process.env.WHATSAPP_DOCUMENT_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BYTES;
  return Math.floor(parsed);
}

export type DocumentValidationErrorCode =
  | "unsupported_type"
  | "empty_file"
  | "too_large"
  | "blocked_type"
  | "missing_extension";

export class DocumentValidationError extends Error {
  readonly code: DocumentValidationErrorCode;
  readonly status: number;
  readonly userMessage: string;

  constructor(code: DocumentValidationErrorCode, userMessage: string, status = 400) {
    super(userMessage);
    this.name = "DocumentValidationError";
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
  }
}

export function documentValidationUserMessage(code: DocumentValidationErrorCode): string {
  switch (code) {
    case "empty_file":
      return "O arquivo está vazio";
    case "too_large":
      return "O arquivo ultrapassa o limite permitido";
    case "unsupported_type":
    case "blocked_type":
    case "missing_extension":
    default:
      return "Formato de arquivo não permitido";
  }
}

function extOf(name: string): string {
  return extname(name).replace(/^\./, "").toLowerCase();
}

/** Sanitiza o nome só para exibição/download. Nunca usado como caminho de disco. */
export function sanitizeDocumentFileName(name: string, mime: string): string {
  const base = basename(name || "arquivo").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 120);
  if (cleaned) return cleaned;
  const ext = mimeToExtension(mime);
  return ext ? `arquivo.${ext}` : "arquivo";
}

export function mimeToExtension(mime: string): WhatsAppDocumentExtension | null {
  for (const [ext, rule] of Object.entries(EXT_RULES) as [WhatsAppDocumentExtension, { mimes: string[] }][]) {
    if (rule.mimes.includes(mime)) return ext;
  }
  return null;
}

export type ValidatedWhatsAppDocument = {
  buffer: Buffer;
  mimeType: string;
  extension: WhatsAppDocumentExtension;
  fileName: string;
  size: number;
};

/** Valida arquivo de documento WhatsApp (extensão + MIME + tamanho + conteúdo). */
export async function validateWhatsAppDocument(file: File): Promise<ValidatedWhatsAppDocument> {
  const originalName = file.name || "arquivo";
  const ext = extOf(originalName);

  if (!ext) {
    throw new DocumentValidationError("missing_extension", documentValidationUserMessage("missing_extension"));
  }
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new DocumentValidationError("blocked_type", documentValidationUserMessage("blocked_type"), 415);
  }

  const rule = EXT_RULES[ext as WhatsAppDocumentExtension];
  if (!rule) {
    throw new DocumentValidationError("unsupported_type", documentValidationUserMessage("unsupported_type"), 415);
  }

  const size = file.size;
  if (size <= 0) {
    throw new DocumentValidationError("empty_file", documentValidationUserMessage("empty_file"));
  }

  const maxBytes = whatsappDocumentMaxBytes();
  if (size > maxBytes) {
    throw new DocumentValidationError("too_large", documentValidationUserMessage("too_large"), 413);
  }

  const declaredMime = (file.type || "").toLowerCase();
  if (declaredMime && !rule.mimes.includes(declaredMime)) {
    throw new DocumentValidationError("unsupported_type", documentValidationUserMessage("unsupported_type"), 415);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.length) {
    throw new DocumentValidationError("empty_file", documentValidationUserMessage("empty_file"));
  }

  const mimeType = declaredMime && rule.mimes.includes(declaredMime) ? declaredMime : rule.mime;
  const fileName = sanitizeDocumentFileName(originalName, mimeType);

  return {
    buffer,
    mimeType,
    extension: ext as WhatsAppDocumentExtension,
    fileName,
    size: buffer.length,
  };
}
