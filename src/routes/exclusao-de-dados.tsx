import { createFileRoute } from "@tanstack/react-router";
import {
  LEGAL_CONTACT_EMAIL,
  LegalSection,
  PublicLegalLayout,
} from "@/components/public-legal-layout";

export const Route = createFileRoute("/exclusao-de-dados")({
  component: ExclusaoDeDadosPage,
  head: () => ({
    meta: [
      { title: "Exclusão de Dados — NexaBoot" },
      {
        name: "description",
        content:
          "Como solicitar a exclusão de dados pessoais na plataforma NexaBoot (NexaTech).",
      },
    ],
  }),
});

function ExclusaoDeDadosPage() {
  return (
    <PublicLegalLayout title="Exclusão de Dados — NexaBoot" currentPath="/exclusao-de-dados">
      <p className="mt-6 text-base leading-relaxed text-muted-foreground">
        Esta página explica como solicitar a exclusão de dados pessoais tratados no NexaBoot,
        produto da NexaTech. O procedimento abaixo atende solicitações de titulares e requisitos de
        transparência para publicação e uso de aplicativos integrados à Meta.
      </p>

      <LegalSection title="1. Como solicitar a exclusão">
        <p>
          Envie um e-mail para{" "}
          <a
            href={`mailto:${LEGAL_CONTACT_EMAIL}?subject=${encodeURIComponent("Solicitação de exclusão de dados — NexaBoot")}`}
            className="font-medium text-primary hover:underline"
          >
            {LEGAL_CONTACT_EMAIL}
          </a>{" "}
          com o assunto sugerido: <em>“Solicitação de exclusão de dados — NexaBoot”</em>.
        </p>
        <p>Na mensagem, informe:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">nome completo</strong> do solicitante;
          </li>
          <li>
            <strong className="text-foreground">e-mail</strong> utilizado na conta ou para
            contato;
          </li>
          <li>
            <strong className="text-foreground">nome da empresa</strong> associada à conta
            NexaBoot;
          </li>
          <li>
            <strong className="text-foreground">identificação da conta</strong> (por exemplo,
            e-mail de login, nome do workspace/empresa na plataforma ou outro dado que permita
            localizar o cadastro);
          </li>
          <li>descrição clara do que deseja excluir (conta de usuário, dados da empresa, etc.).</li>
        </ul>
        <p>
          Podemos solicitar informações adicionais para confirmar a identidade do solicitante e
          evitar exclusões indevidas.
        </p>
      </LegalSection>

      <LegalSection title="2. Análise e processamento">
        <p>
          Após o recebimento, analisaremos a solicitação, verificaremos a titularidade/legitimidade
          e iniciaremos o processamento da exclusão ou anonimização dos dados cabíveis. O prazo
          pode variar conforme a complexidade do pedido, o volume de dados e a necessidade de
          validações. Comunicaremos o andamento pelo e-mail informado na solicitação.
        </p>
        <p>
          Não estabelecemos nesta página um prazo legal específico além do que a legislação
          aplicável e as circunstâncias do caso concreto exigirem; em caso de dúvida, entre em
          contato pelo e-mail acima.
        </p>
      </LegalSection>

      <LegalSection title="3. Dados que podem ser mantidos">
        <p>
          Alguns dados podem ser mantidos mesmo após a solicitação de exclusão quando houver
          obrigação legal, regulatória, contratual ou necessidade de exercício regular de direitos
          (por exemplo, registros necessários a auditoria, prevenção a fraudes ou cumprimento de
          deveres legais). Nesses casos, a retenção será limitada ao necessário e pelo tempo
          adequado à finalidade remanescente.
        </p>
      </LegalSection>

      <LegalSection title="4. Efeitos da exclusão no acesso à plataforma">
        <p>
          A exclusão de dados de conta de usuário ou de dados essenciais da empresa contratante
          pode resultar no encerramento ou na impossibilidade de acesso à plataforma NexaBoot. Se a
          solicitação abranger a conta administrativa ou dados operacionais críticos, o serviço
          associado poderá deixar de funcionar para os usuários afetados.
        </p>
      </LegalSection>

      <LegalSection title="5. Dados associados ao login da Meta">
        <p>
          Se a sua conta ou integração utilizar autenticação, permissões ou dados provenientes da
          Meta (incluindo login ou conexão com produtos Meta/WhatsApp):
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            inclua na solicitação que o pedido envolve <strong className="text-foreground">dados
            associados ao login ou à integração com a Meta</strong>;
          </li>
          <li>
            informe o e-mail/identificador da conta NexaBoot e, se disponível, o identificador
            associado à Meta utilizado na conexão;
          </li>
          <li>
            após recebermos o pedido válido, removeremos ou desvincularemos, na medida do possível,
            os dados pessoais armazenados no NexaBoot que estejam ligados a essa autenticação ou
            integração;
          </li>
          <li>
            observe que a Meta também pode manter dados sob suas próprias políticas; para exercer
            direitos diretamente junto à Meta, utilize os canais e configurações disponibilizados
            pela Meta.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="6. Contato">
        <p>
          Solicitações e dúvidas sobre exclusão de dados:{" "}
          <a
            href={`mailto:${LEGAL_CONTACT_EMAIL}`}
            className="font-medium text-primary hover:underline"
          >
            {LEGAL_CONTACT_EMAIL}
          </a>
          . Veja também a{" "}
          <a
            href="/politica-de-privacidade"
            className="font-medium text-primary hover:underline"
          >
            Política de Privacidade
          </a>{" "}
          e os{" "}
          <a href="/termos-de-uso" className="font-medium text-primary hover:underline">
            Termos de Uso
          </a>
          .
        </p>
      </LegalSection>
    </PublicLegalLayout>
  );
}
