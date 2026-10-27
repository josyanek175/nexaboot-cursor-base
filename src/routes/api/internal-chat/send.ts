import { createFileRoute } from "@tanstack/react-router";
import { sendInternalMessage } from "@/lib/internal-message-send.server";
export const Route = createFileRoute("/api/internal-chat/send")({
  server: { handlers: { POST: async ({ request }) => sendInternalMessage(request) } },
});
