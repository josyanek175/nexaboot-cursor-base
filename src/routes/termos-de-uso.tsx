import { createFileRoute } from "@tanstack/react-router";
import {
  LEGAL_CONTACT_EMAIL,
  LegalSection,
  PublicLegalLayout,
} from "@/components/public-legal-layout";

export const Route = createFileRoute("/termos-de-uso")({
  component: TermosDeUsoPage,
  head: () => ({
    meta: [
      { title: "Termos de Uso — NexaBoot" },
      {
        name: "description",
        content:
          "Termos de Uso da plataforma NexaBoot — atendimento e comunicação empresarial via WhatsApp.",
      },
    ],
  }),
});

function TermosDeUsoPage() {
  return (
    <PublicLegalLayout title="Termos de Uso — NexaBoot" currentPath="/termos-de-uso">
      <p className="mt-6 text-base leading-relaxed text-muted-foreground">
        Estes Termos de Uso regulam o acesso e a utilização da plataforma NexaBoot, produto da
        NexaTech. Ao utilizar o NexaBoot, a empresa contratante e seus usuários aceitam as
        condições abaixo.
      </p>

      <LegalSection title="1. Descrição do NexaBoot">
        <p>
          O NexaBoot é uma plataforma SaaS de multiatendimento e comunicação empresarial integrada
          ao WhatsApp, incluindo recursos de conversas, gestão de canais, campanhas e demais
          funcionalidades disponibilizadas na conta contratada. A integração com a WhatsApp Cloud
          API e serviços da Meta pode ser utilizada conforme a configuração da conta.
        </p>
      </LegalSection>

      <LegalSection title="2. Condições de acesso">
        <p>
          O acesso à plataforma ocorre mediante credenciais de login fornecidas ou criadas para a
          conta da empresa contratante. Cada usuário é responsável por manter a confidencialidade
          de suas credenciais e por todas as ações realizadas sob seu login. O contratante deve
          garantir que apenas pessoas autorizadas tenham acesso.
        </p>
      </LegalSection>

      <LegalSection title="3. Responsabilidades do usuário e da empresa contratante">
        <p>Compete à empresa contratante e aos seus usuários:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>utilizar a plataforma de forma lícita e em conformidade com estes Termos;</li>
          <li>
            obter as bases legais e consentimentos necessários para o tratamento de dados de
            contatos e clientes, quando exigido;
          </li>
          <li>manter informações cadastrais atualizadas;</li>
          <li>
            configurar adequadamente canais, permissões e conteúdos enviados aos destinatários;
          </li>
          <li>não compartilhar acessos indevidamente com terceiros.</li>
        </ul>
      </LegalSection>

      <LegalSection title="4. Uso permitido e proibido">
        <p>É permitido utilizar o NexaBoot para atendimento e comunicação empresarial legítima.</p>
        <p>É proibido, entre outras condutas:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>enviar spam, mensagens fraudulentas ou conteúdo ilícito;</li>
          <li>violar direitos de terceiros ou a legislação aplicável;</li>
          <li>tentar obter acesso não autorizado a sistemas, contas ou dados;</li>
          <li>interferir no funcionamento da plataforma ou de infraestrutura relacionada;</li>
          <li>
            utilizar o serviço de forma que viole políticas do WhatsApp, da Meta ou destes Termos.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="5. Responsabilidade sobre mensagens enviadas">
        <p>
          A empresa contratante e seus usuários são integralmente responsáveis pelo conteúdo das
          mensagens, campanhas e comunicações enviadas por meio da plataforma, bem como pela
          seleção dos destinatários e pela conformidade dessas comunicações com a legislação e com
          as políticas dos canais utilizados.
        </p>
      </LegalSection>

      <LegalSection title="6. Políticas do WhatsApp e da Meta">
        <p>
          O uso de recursos integrados ao WhatsApp e à Meta está sujeito às políticas, termos e
          diretrizes da Meta/WhatsApp. A NexaTech/NexaBoot não se responsabiliza por restrições,
          bloqueios, limitações de envio ou medidas aplicadas pela Meta em razão do uso do canal
          pelo contratante.
        </p>
      </LegalSection>

      <LegalSection title="7. Indisponibilidades e manutenção">
        <p>
          Poderemos realizar manutenções programadas ou emergenciais e enfrentar indisponibilidades
          decorrentes de fatores técnicos, de infraestrutura de terceiros (incluindo Meta/WhatsApp)
          ou de caso fortuito/força maior. Empregaremos esforços razoáveis para restabelecer o
          serviço, sem garantia de disponibilidade ininterrupta.
        </p>
      </LegalSection>

      <LegalSection title="8. Propriedade intelectual">
        <p>
          A plataforma NexaBoot, incluindo software, marca, layout, documentação e demais elementos
          associados, é de titularidade da NexaTech ou de seus licenciadores. O uso da plataforma
          não transfere direitos de propriedade intelectual ao contratante, salvo a licença de uso
          limitada, não exclusiva e intransferível necessária à utilização do serviço contratado.
        </p>
      </LegalSection>

      <LegalSection title="9. Suspensão e encerramento">
        <p>
          Podemos suspender ou encerrar o acesso em casos de violação destes Termos, uso indevido,
          risco à segurança, inadimplemento contratual (quando aplicável) ou determinação legal. O
          contratante também pode solicitar o encerramento conforme as condições comerciais
          acordadas. Após o encerramento, o acesso à plataforma poderá ser desabilitado.
        </p>
      </LegalSection>

      <LegalSection title="10. Limitação de responsabilidade">
        <p>
          Na máxima extensão permitida pela lei, a NexaTech/NexaBoot não se responsabiliza por
          danos indiretos, lucros cessantes, perda de dados causada por uso inadequado do
          contratante, ou por atos, omissões ou políticas de terceiros (incluindo Meta/WhatsApp). A
          responsabilidade, quando existente, limita-se ao que for estabelecido no contrato
          comercial aplicável.
        </p>
      </LegalSection>

      <LegalSection title="11. Alterações dos termos">
        <p>
          Estes Termos de Uso poderão ser atualizados periodicamente. A versão vigente estará
          disponível nesta página, com a data da última atualização. O uso continuado da plataforma
          após a publicação de alterações implica ciência das novas condições, quando aplicável.
        </p>
      </LegalSection>

      <LegalSection title="12. Contato">
        <p>
          Dúvidas sobre estes Termos de Uso podem ser enviadas à NexaTech/NexaBoot pelo e-mail:{" "}
          <a
            href={`mailto:${LEGAL_CONTACT_EMAIL}`}
            className="font-medium text-primary hover:underline"
          >
            {LEGAL_CONTACT_EMAIL}
          </a>
          . Consulte também a{" "}
          <a
            href="/politica-de-privacidade"
            className="font-medium text-primary hover:underline"
          >
            Política de Privacidade
          </a>{" "}
          e a página de{" "}
          <a href="/exclusao-de-dados" className="font-medium text-primary hover:underline">
            Exclusão de Dados
          </a>
          .
        </p>
      </LegalSection>
    </PublicLegalLayout>
  );
}
