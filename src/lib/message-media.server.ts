// Content-Disposition para download de mídia CRM (/api/messages/:id/media).

export function messageMediaContentDisposition(mime: string, fileName: string | null): string {
  const name = (fileName || "arquivo").replace(/["\\\r\n]/g, "");
  const inline = mime === "application/pdf";
  const dispo = inline ? "inline" : "attachment";
  const encoded = encodeURIComponent(name);
  return `${dispo}; filename="${name}"; filename*=UTF-8''${encoded}`;
}
