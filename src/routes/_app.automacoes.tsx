import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/placeholder-page";

export const Route = createFileRoute("/_app/automacoes")({
  component: () => (
    <PlaceholderPage
      title="Automações N8N"
      description="Webhooks N8N por empresa/canal, gatilhos (mensagem recebida, palavra-chave, mídia, etc.), ações executáveis e logs de execução."
    />
  ),
});
