import { createFileRoute } from "@tanstack/react-router";
import {
  LEGAL_CONTACT_EMAIL,
  LegalSection,
  PublicLegalLayout,
} from "@/components/public-legal-layout";

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

function PoliticaPrivacidadePage() {
  return (
    <PublicLegalLayout
      title="Política de Privacidade — NexaBoot"
      currentPath="/politica-de-privacidade"
    >
      <p className="mt-6 text-base leading-relaxed text-muted-foreground">
        A NexaBoot, produto da NexaTech, é uma plataforma de atendimento e comunicação empresarial
        integrada ao WhatsApp e à WhatsApp Cloud API (Meta). Esta Política de Privacidade explica
        como coletamos, usamos, armazenamos e protegemos informações tratadas durante o uso da
        plataforma.
      </p>

      <LegalSection title="1. Dados coletados">
        <p>
          Durante o uso do NexaBoot, podemos tratar, conforme a configuração da conta e o uso dos
          recursos:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">Dados de login e autenticação:</strong> e-mail,
            senha (armazenada de forma criptografada/hash), tokens de sessão e registros de acesso
            necessários à segurança da conta.
          </li>
          <li>
            <strong className="text-foreground">Dados de empresas e usuários:</strong> nome da
            empresa, identificação da conta, nomes de usuários operadores, papéis/permissões e
            dados cadastrais informados na plataforma.
          </li>
          <li>
            <strong className="text-foreground">Contatos e mensagens:</strong> nome e número de
            telefone de contatos, conteúdo de mensagens enviadas e recebidas, mídias quando
            aplicável, status de entrega e leitura, e histórico de atendimento.
          </li>
          <li>
            <strong className="text-foreground">Dados técnicos:</strong> informações de canais
            conectados, logs operacionais, identificadores técnicos e metadados necessários à
            operação, segurança e auditoria do serviço.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="2. Finalidade do tratamento">
        <p>Os dados são utilizados para:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>permitir o atendimento a clientes via WhatsApp;</li>
          <li>organizar conversas e registrar histórico de atendimento;</li>
          <li>gerenciar canais conectados e usuários da empresa;</li>
          <li>enviar e receber mensagens e acompanhar o status das comunicações;</li>
          <li>autenticar usuários e proteger o acesso à plataforma;</li>
          <li>cumprir obrigações legais e manter a segurança e a auditoria do serviço.</li>
        </ul>
      </LegalSection>

      <LegalSection title="3. Dados de login e autenticação">
        <p>
          Credenciais e sessões são tratadas exclusivamente para autenticação, controle de acesso e
          prevenção de uso indevido. Não utilizamos senhas em texto puro; o acesso às informações
          da conta depende de autenticação válida e das permissões configuradas pela empresa
          contratante.
        </p>
      </LegalSection>

      <LegalSection title="4. Dados de empresas, usuários, contatos e mensagens">
        <p>
          O NexaBoot processa dados de empresas e usuários operadores para gestão da conta, e dados
          de contatos e mensagens para viabilizar o multiatendimento. A empresa contratante é
          responsável pelas finalidades e pela base legal do tratamento dos dados dos seus
          clientes/contatos no contexto do atendimento.
        </p>
      </LegalSection>

      <LegalSection title="5. Integração com WhatsApp e Meta">
        <p>
          Para envio e recebimento de mensagens, o NexaBoot integra-se a serviços da Meta,
          incluindo a WhatsApp Cloud API e, quando aplicável, fluxos de autenticação ou conexão
          associados à Meta. Dados necessários à entrega das mensagens (como número de telefone,
          conteúdo e metadados da conversa) podem ser transmitidos à Meta conforme as políticas e
          termos da Meta/WhatsApp vigentes. O uso desses serviços também está sujeito às regras da
          Meta.
        </p>
      </LegalSection>

      <LegalSection title="6. Armazenamento e segurança">
        <p>
          Adotamos medidas técnicas e organizacionais para proteger os dados contra acesso não
          autorizado, perda, alteração ou uso indevido. O acesso às informações é restrito a
          usuários autorizados conforme as permissões configuradas na plataforma. Utilizamos
          infraestrutura de hospedagem e banco de dados adequados à operação do serviço.
        </p>
      </LegalSection>

      <LegalSection title="7. Compartilhamento com fornecedores">
        <p>
          A NexaBoot <strong className="text-foreground">não vende</strong> dados pessoais. Os
          dados podem ser compartilhados apenas com fornecedores necessários à operação do
          serviço, como Meta/WhatsApp Cloud API, provedores de hospedagem, banco de dados e demais
          ferramentas técnicas essenciais ao funcionamento da plataforma, sempre limitados ao
          necessário para a prestação do serviço.
        </p>
      </LegalSection>

      <LegalSection title="8. Direitos do titular (LGPD)">
        <p>
          Nos termos da Lei Geral de Proteção de Dados Pessoais (LGPD — Lei nº 13.709/2018), os
          titulares podem solicitar confirmação de tratamento, acesso, correção, anonimização,
          portabilidade (quando aplicável), eliminação e demais direitos previstos na legislação,
          observadas as hipóteses legais de retenção. Solicitações podem ser feitas pelo e-mail
          indicado na seção de contato.
        </p>
      </LegalSection>

      <LegalSection title="9. Retenção e exclusão">
        <p>
          Os dados são mantidos pelo tempo necessário para cumprir as finalidades desta política,
          obrigações legais, contratuais ou operacionais. Após solicitação válida de exclusão, ou
          quando não houver mais necessidade de retenção, procederemos à eliminação ou
          anonimização, ressalvados os casos em que a manutenção seja exigida por lei ou necessária
          para exercício regular de direitos. Para o procedimento detalhado de solicitação, consulte
          a página{" "}
          <a href="/exclusao-de-dados" className="font-medium text-primary hover:underline">
            Exclusão de Dados
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title="10. Contato para privacidade">
        <p>
          Para dúvidas ou solicitações relacionadas à privacidade e proteção de dados, entre em
          contato com a NexaTech/NexaBoot pelo e-mail:{" "}
          <a
            href={`mailto:${LEGAL_CONTACT_EMAIL}`}
            className="font-medium text-primary hover:underline"
          >
            {LEGAL_CONTACT_EMAIL}
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title="11. Alterações nesta política">
        <p>
          Esta Política de Privacidade poderá ser atualizada periodicamente. A versão mais recente
          estará sempre disponível nesta página, com a data da última atualização indicada no
          topo.
        </p>
      </LegalSection>
    </PublicLegalLayout>
  );
}
