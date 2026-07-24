// Constantes compartilhadas de documentos WhatsApp (client + server).

export const WHATSAPP_DOCUMENT_ACCEPT =
  ".pdf,.doc,.docx,.xls,.xlsx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const WHATSAPP_DOCUMENT_EXTENSIONS = ["pdf", "doc", "docx", "xls", "xlsx"] as const;

const EXT_MIMES: Record<string, string[]> = {
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
};

const BLOCKED = new Set([
  "exe", "bat", "sh", "js", "html", "htm", "php", "msi", "cmd", "scr",
  "com", "vbs", "ps1", "jar", "dll",
]);

export const WHATSAPP_DOCUMENT_MAX_BYTES_DEFAULT = 16 * 1024 * 1024;

export function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

export type ClientDocumentValidation =
  | { ok: true }
  | { ok: false; message: string };

/** Validação leve no frontend (backend revalida). */
export function validateClientDocument(file: File, maxBytes = WHATSAPP_DOCUMENT_MAX_BYTES_DEFAULT): ClientDocumentValidation {
  const ext = fileExtension(file.name);
  if (!ext) return { ok: false, message: "Formato de arquivo não permitido" };
  if (BLOCKED.has(ext)) return { ok: false, message: "Formato de arquivo não permitido" };
  if (!WHATSAPP_DOCUMENT_EXTENSIONS.includes(ext as (typeof WHATSAPP_DOCUMENT_EXTENSIONS)[number])) {
    return { ok: false, message: "Formato de arquivo não permitido" };
  }
  const mimes = EXT_MIMES[ext];
  const declared = (file.type || "").toLowerCase();
  if (declared && mimes && !mimes.includes(declared)) {
    return { ok: false, message: "Formato de arquivo não permitido" };
  }
  if (file.size <= 0) return { ok: false, message: "O arquivo está vazio" };
  if (file.size > maxBytes) return { ok: false, message: "O arquivo ultrapassa o limite permitido" };
  return { ok: true };
}

export function isPdfMime(mime?: string | null): boolean {
  return (mime || "").toLowerCase() === "application/pdf";
}

export function documentExtensionLabel(name?: string | null, mime?: string | null): string {
  const ext = fileExtension(name || "");
  if (ext) return ext.toUpperCase();
  if (isPdfMime(mime)) return "PDF";
  if ((mime || "").includes("wordprocessingml")) return "DOCX";
  if ((mime || "").includes("spreadsheetml")) return "XLSX";
  if ((mime || "").includes("msword")) return "DOC";
  if ((mime || "").includes("ms-excel")) return "XLS";
  return "DOC";
}
