import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/configuracoes")({
  component: () => (
    <PlaceholderPage
      title="Configurações"
      description="Credenciais Meta WhatsApp Cloud API, Evolution API e N8N. Tokens, webhooks, phone_number_id, business_account_id e segredos."
    />
  ),
});
