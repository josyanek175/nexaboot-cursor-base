# Atendimento na DEV: conversa contínua e botões Meta

Esta versão integra os recursos de produção de `21072f9` com a arquitetura durável anterior da DEV (`228b578`). A main de produção não foi alterada nesta entrega.

## Conversas e histórico

O cliente permanece na mesma conversa por empresa, contato e canal. Uma mensagem nova após `finished`, `closed` ou `resolved` reabre essa conversa e reinicia a sessão do fluxo. Atribuições antigas são liberadas. Uma reentrega do mesmo wamid não reabre nem reinicia o atendimento.

As mensagens antigas não são movidas ou apagadas. A listagem comum prioriza a conversa atual por contato/canal. A fila de campanhas mantém sua organização própria. A API de mensagens pode apresentar juntos os históricos que já ficaram separados, sempre exigindo a mesma empresa, contato e canal.

A interface permite carregar mensagens anteriores. O cursor usa horário com microssegundos e ID para não perder mensagens com horários iguais. O polling preserva o histórico já carregado. O payload retornado na listagem contém somente as informações necessárias para exibir o menu/template, sem retornar o payload bruto inteiro.

## Botões

Etapas com opções passam título e identificador ao provider Meta. O Graph recebe `type=interactive`, `interactive.type=button` e ações `reply`. São permitidos de um a três botões, títulos com até vinte caracteres e corpo com até 1024. A resposta pode avançar pelo ID estável. O envio manual de texto continua textual; Evolution mantém alternativa numerada.

O nome do perfil continua adiado. O fluxo usa saudação genérica e preserva os nomes cadastrados. Não depende de `whatsapp_profile_name` ou da antiga `attendance_automation_jobs`.

## Transações, retentativas e arquitetura durável

O webhook legado grava primeiro contato, conversa e mensagem. O bot só envia depois do commit. O estado do trabalho vive em `messages.raw_payload.__nexaFlow`, sem nova tabela de automação. Lease, token de posse e deduplicação das saídas evitam execução concorrente indevida.

A arquitetura durável reaproveitada da DEV usa inbox, outbox, RabbitMQ e tarefas de mídia/campanha que já existiam nesse desenvolvimento. O domínio Meta do worker agora chama a mesma persistência do caminho legado. Lotes com canais de empresas diferentes resolvem cada canal separadamente. Echo do Business App é saída; não reenvia, não inicia fluxo e não reabre conversa finalizada. Status são associados ao canal da mensagem.

O message-worker ativo também busca trabalhos de fluxo pendentes, com retentativa disponível ou lease expirado, e os retoma sem exigir outra mensagem do cliente. No web legado sozinho essa recuperação em background não é ligada. O índice opcional `20261022_dev_flow_recovery_index.sql` melhora essa busca. Os três workers são empacotados em `.output/workers`; cada serviço deve ser configurado separadamente. Todas as flags duráveis continuam desligadas por padrão.

O processo do message-worker fixa a camada de domínio no mesmo banco configurado para sua inbox. Pools separados continuam consumindo conexões e precisam de orçamento conjunto.

## Limites

Aceite pela Meta sem confirmação persistida ainda é um resultado ambíguo; não há garantia absoluta de envio exatamente uma vez no provedor externo. Uma chamada já em andamento não pode ser desfeita se um humano assumir naquele instante. O bloqueio impede as próximas etapas e gravações tardias da sessão.

As migrações duráveis anteriores só são necessárias se a arquitetura experimental for ativada em homologação. Elas não devem ser aplicadas em produção por causa desta entrega. Não ligar flags duráveis antes de conferir schema, broker, filas, storage e serviços.

## Multiempresa

O contexto operacional do cliente e do servidor usa `company_id`, inclusive quando o campo legado `tenant_id` é compartilhado. Não há identidade de demonstração nem troca de perfil fictício na sessão. Trocar empresa operacional recarrega a aplicação.

`/empresa1` é uma entrada por slug, validada contra a empresa do usuário. O endereço não concede autorização. O cadastro do slug exige a migração DEV `20261022_dev_company_workspace.sql`; as leituras antigas não dependem dessa coluna. A tela Empresas oferece a configuração do endereço, limitada ao administrador da própria empresa ou plataforma.

Administradores de empresa não podem criar, promover, redefinir senha ou desativar identidades de plataforma. Mídias e históricos continuam protegidos por empresa. Respostas de API autenticadas não ficam em cache reutilizável após mudança de login.

## Validação

- 65 cenários em PostgreSQL local real com pool de oito conexões.
- Os mesmos 65 cenários com uma conexão.
- 33 verificações de workspace, histórico, mídia, permissões e payload nativo de botões.
- 24 suítes de regressão de Meta, coexistência, automação, sessões, filas, mídia e campanhas.
- Compilação do web e empacotamento dos workers.

Os testes recusam bancos não locais e nomes que não terminem em `_test`. As tabelas duráveis usadas nos testes são fixtures separadas, criadas somente após demonstrar que o caminho legado funciona sem elas. O provider Meta e o broker são simulados nas verificações de domínio. Teste com WhatsApp e RabbitMQ reais em homologação ainda é necessário.
