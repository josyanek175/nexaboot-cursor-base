import { createFileRoute } from "@tanstack/react-router";
import { createInternalChat } from "@/lib/internal-chat-create.server";
export const Route = createFileRoute("/api/internal-chat/create")({
  server: { handlers: { POST: async ({ request }) => createInternalChat(request) } },
});
