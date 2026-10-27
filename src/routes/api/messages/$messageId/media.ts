import { createFileRoute } from "@tanstack/react-router";
import { getMessageMedia } from "@/lib/message-media-read.server";
export const Route = createFileRoute("/api/messages/$messageId/media")({
  server: { handlers: { GET: async ({ params }) => getMessageMedia(params.messageId) } },
});
