import {
  DocumentValidationError,
  sanitizeDocumentFileName,
} from "@/lib/whatsapp-document-validation.server";
export async function validateForwardImage(file: File) {
  if (!file.size) throw new DocumentValidationError("empty_file", "A imagem está vazia");
  if (file.size > 5 * 1024 * 1024)
    throw new DocumentValidationError("too_large", "A imagem ultrapassa o limite de 5 MB", 413);
  const buffer = Buffer.from(await file.arrayBuffer());
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const mimeType = png ? "image/png" : jpeg ? "image/jpeg" : null;
  if (!mimeType || (file.type && file.type !== mimeType))
    throw new DocumentValidationError(
      "unsupported_type",
      "Encaminhe uma imagem JPEG ou PNG válida",
      415,
    );
  const extension = png ? "png" : "jpg";
  return {
    buffer,
    mimeType,
    extension,
    fileName: `${sanitizeDocumentFileName(file.name || "imagem", mimeType).replace(/\.[^.]*$/, "")}.${extension}`,
    size: buffer.length,
  };
}
