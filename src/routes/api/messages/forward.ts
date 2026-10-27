import { createFileRoute } from "@tanstack/react-router";
import { forwardMessage } from "@/lib/message-forward.server";
export const Route = createFileRoute("/api/messages/forward")({
  server: { handlers: { POST: async ({ request }) => forwardMessage(request) } },
});
