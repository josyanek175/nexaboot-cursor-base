import { createFileRoute, Link } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";

export const Route = createFileRoute("/politica-de-privacidade")({
  component: PoliticaPrivacidadePage,
  head: () => ({
    meta: [
      { title: "Política de Privacidade — NexaBoot" },
      {
        name: "description",
        content:
          "Política de Privacidade da plataforma NexaBoot — atendimento e comunicação via WhatsApp e WhatsApp Cloud API.",
      },
    ],
  }),
});

const CONTACT_EMAIL = "contato@nexaboot.com";

function PoliticaPrivacidadePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <Link to="/login" className="flex items-center gap-3 hover:opacity-90">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-whatsapp text-whatsapp-foreground">
              <MessageCircle className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">NexaBoot</div>
              <div className="text-xs text-muted-foreground">NexaTech</div>
            </div>
          </Link>
          <Link
            to="/login"
            className="text-sm font-medium text-primary hover:underline"
          >
            Entrar
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <article className="max-w-none">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Política de Privacidade — NexaBoot
          </h1>
          <p className="text-sm text-muted-foreground">Última atualização: Julho de 2026</p>

          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            A NexaBoot é uma plataforma de atendimento e comunicação empresarial integrada ao
            WhatsApp e à WhatsApp Cloud API. Esta Política de Privacidade explica como coletamos,
            usamos, armazenamos e protegemos informações tratadas durante o uso da plataforma.
          </p>

          <section className="mt-10 space-y-3">
            <h2 className="text-xl font-semibold">1. Dados tratados</h2>
            <p className="text-muted-foreground leading-relaxed">
              Durante o uso do NexaBoot, podemos tratar dados como nome, número de telefone,
              mensagens enviadas e recebidas, status de entrega e leitura, informações de
              atendimento, canais conectados e dados técnicos necessários para operação da
              plataforma.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="text-xl font-semibold">2. Finalidade do uso</h2>
            <p className="text-muted-foreground leading-relaxed">
              Os dados são utilizados para permitir o atendimento a clientes via WhatsApp,
              organizar conversas, registrar histórico de atendimento, gerenciar canais
              conectados, enviar e receber mensagens, acompanhar status das comunicações e manter a
              segurança e auditoria da plataforma.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="text-xl font-semibold">3. Compartilhamento de dados</h2>
            <p className="text-muted-foreground leading-relaxed">
              A NexaBoot <strong>não vende</strong> dados pessoais. Os dados podem ser
              compartilhados apenas com provedores necessários para a operação do serviço, como a
              Meta/WhatsApp Cloud API, serviços de hospedagem, banco de dados e ferramentas
              técnicas essenciais ao funcionamento da plataforma.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="text-xl font-semibold">4. Armazenamento e segurança</h2>
            <p className="text-muted-foreground leading-relaxed">
              Adotamos medidas técnicas e organizacionais para proteger os dados contra acesso não
              autorizado, perda, alteração ou uso indevido. O acesso às informações é restrito a
              usuários autorizados conforme as permissões configuradas na plataforma.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="text-xl font-semibold">5. Direitos dos titulares</h2>
            <p className="text-muted-foreground leading-relaxed">
              Nos termos da Lei Geral de Proteção de Dados Pessoais (LGPD), os titulares podem
              solicitar informações sobre seus dados, correção, exclusão ou demais direitos
              aplicáveis, conforme a legislação vigente.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="text-xl font-semibold">6. Retenção de dados</h2>
            <p className="text-muted-foreground leading-relaxed">
              Os dados são mantidos pelo tempo necessário para cumprir as finalidades descritas
              nesta política, obrigações legais, contratuais ou operacionais.
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="text-xl font-semibold">7. Contato</h2>
            <p className="text-muted-foreground leading-relaxed">
              Para dúvidas ou solicitações relacionadas à privacidade e proteção de dados, entre
              em contato pelo e-mail:{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="font-medium text-primary hover:underline"
              >
                {CONTACT_EMAIL}
              </a>
            </p>
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="text-xl font-semibold">8. Alterações nesta política</h2>
            <p className="text-muted-foreground leading-relaxed">
              Esta Política de Privacidade poderá ser atualizada periodicamente. A versão mais
              recente estará sempre disponível nesta página.
            </p>
          </section>
        </article>
      </main>

      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-3xl flex-col items-center justify-between gap-2 px-4 py-6 text-center text-xs text-muted-foreground sm:flex-row sm:px-6 sm:text-left">
          <span>© {new Date().getFullYear()} NexaBoot — NexaTech</span>
          <Link to="/login" className="hover:text-foreground hover:underline">
            Voltar ao login
          </Link>
        </div>
      </footer>
    </div>
  );
}
