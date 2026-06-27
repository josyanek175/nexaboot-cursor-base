import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { ScrollText, ShieldAlert } from "lucide-react";
import { useAuditLog, type AuditAction } from "@/lib/audit-log";
import { useSession } from "@/lib/session";
import { tenants } from "@/lib/mocks";

export const Route = createFileRoute("/_app/logs")({
  component: LogsPage,
});

const ACTION_LABEL: Record<AuditAction, string> = {
  "user.create": "Criação de usuário",
  "user.update": "Edição de usuário",
  "user.password_change": "Alteração de senha",
  "user.password_reset": "Reset de senha (admin)",
  "user.block": "Bloqueio de usuário",
  "user.unblock": "Desbloqueio de usuário",
  "user.delete": "Exclusão de usuário",
  "tenant.create": "Criação de empresa",
  "tenant.update": "Edição de empresa",
  "tenant.toggle_status": "Mudança de status da empresa",
  "channel.create": "Criação de canal",
  "channel.update": "Edição de canal",
  "channel.toggle": "Conexão/Desconexão de canal",
  "channel.test": "Teste de conexão",
  "channel.qr_generated": "QR Code gerado",
  "channel.instance_connected": "Instância conectada",
  "channel.instance_disconnected": "Instância desconectada",
  "channel.webhook_configured": "Webhook configurado",
  "message.sent": "Mensagem enviada",
  "message.received": "Mensagem recebida",
  "message.media_received": "Mídia recebida",
  "message.send_error": "Erro ao enviar mensagem",
  "webhook.received": "Webhook recebido",
  "webhook.error": "Erro no webhook",
  "conversation.assign": "Atribuição de conversa",
  "conversation.auto_assign": "Conversa assumida automaticamente",
  "conversation.transfer": "Transferência de conversa",
  "access.denied": "Acesso negado por tenant",
  "permission.denied": "Ação sem permissão",
  "auth.login.success": "Login realizado",
  "auth.login.failed": "Tentativa de login inválida",
  "auth.login.blocked": "Login bloqueado",
  "auth.logout": "Logout",
  "auth.password.reset_requested": "Recuperação de senha solicitada",
  "contact.create": "Contato criado",
  "contact.update": "Contato atualizado",
  "contact.delete": "Contato excluído",
  "contact.import": "Importação de contatos",
};

function LogsPage() {
  const { session, isSuperAdmin } = useSession();

  // Isolamento: ADMIN_GERAL vê tudo; demais perfis veem apenas o próprio tenant.
  const logs = useAuditLog(isSuperAdmin ? undefined : { tenantId: session.tenantId });
  const tenantName = useMemo(
    () => (id: string | null) => tenants.find((t) => t.id === id)?.name ?? id ?? "—",
    [],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <ScrollText className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Logs e Auditoria</h1>
            <p className="text-xs text-muted-foreground">
              {isSuperAdmin ? "Visão global · ADMIN_GERAL" : `Restrito à empresa ${session.tenantId}`} ·{" "}
              {logs.length} evento(s)
            </p>
          </div>
        </div>
      </header>

      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-6 py-2 text-xs text-muted-foreground">
        <ShieldAlert className="h-3.5 w-3.5" /> Cada log carrega tenant_id; políticas RLS replicam essa visibilidade no Supabase.
      </div>

      <div className="flex-1 overflow-auto p-6">
        {logs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Nenhuma ação registrada nesta sessão.
            <div className="mt-1 text-xs">Crie/edite usuários, canais ou empresas para gerar logs.</div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Data/Hora</th>
                  <th className="px-3 py-2 text-left">Empresa</th>
                  <th className="px-3 py-2 text-left">Responsável</th>
                  <th className="px-3 py-2 text-left">Ação</th>
                  <th className="px-3 py-2 text-left">Alvo</th>
                  <th className="px-3 py-2 text-left">Resultado</th>
                  <th className="px-3 py-2 text-left">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-border hover:bg-muted/20">
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {new Date(l.at).toLocaleString("pt-BR")}
                    </td>
                    <td className="px-3 py-2 text-xs">{tenantName(l.tenantId)}</td>
                    <td className="px-3 py-2 text-xs">{l.actorName}</td>
                    <td className="px-3 py-2 text-xs font-medium">{ACTION_LABEL[l.action]}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{l.targetName ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          l.result === "success"
                            ? "bg-whatsapp/15 text-whatsapp"
                            : l.result === "denied"
                              ? "bg-destructive/15 text-destructive"
                              : "bg-amber-500/15 text-amber-600"
                        }`}
                      >
                        {l.result}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs italic text-muted-foreground">{l.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
