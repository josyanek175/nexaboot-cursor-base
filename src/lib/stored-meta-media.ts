// Resolve somente IDs de mídia Meta; nunca baixa URLs arbitrárias do payload.
export function resolveStoredMetaMedia(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  const message = payload.message as Record<string, unknown> | undefined;
  const type = payload.meta_media_type ?? message?.type;
  if (
    typeof type !== "string" ||
    !["image", "audio", "video", "document", "sticker"].includes(type)
  )
    return null;
  const node = message?.[type] as Record<string, unknown> | undefined;
  const id = payload.meta_media_id ?? node?.id;
  if (typeof id !== "string" || !/^\d+$/.test(id)) return null;
  return {
    id,
    type,
    mimeType: typeof node?.mime_type === "string" ? node.mime_type : null,
    filename: typeof node?.filename === "string" ? node.filename : null,
  };
}
