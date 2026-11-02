# Publicação conjunta na main — 02/11/2026

Base anterior da produção no GitHub: `730bdb0`. Pacote integrado da dev: `61318f4`.

## Conteúdo

- Menu com Atendimento, Campanhas e Chat interno no topo; demais opções agrupadas, Configurações no rodapé e nome Agenda.
- Agenda piloto: profissionais, consultas, bloqueios, confirmação manual, remarcação e texto de lembrete para copiar. Não inclui agendamento pelo fluxo nem disparos automáticos.
- Dashboard, campanhas e espera respeitando números autorizados individualmente e por equipe. Contatos continuam compartilhados dentro da empresa; administradores mantêm visão completa da empresa.
- Diagnóstico de Equipes e números/Configurações, com bloqueio de formulários que não carregaram.
- Reforços de sessão e autorização.

Não inclui transferência de número entre empresas. Nenhuma conexão real de banco ou mensagem externa foi usada na validação local.

## Antes de compilar a produção na EasyPanel

1. Confirmar a conexão do banco efetivamente usada pela **web de produção**, e ter backup recuperável. Neste projeto, o nome `nexaboot_dev` já foi utilizado em produção: o nome isolado não identifica o ambiente.
2. Executar primeiro somente o diagnóstico `scripts/diagnostics/20261102_release_preflight.sql` nessa conexão. Ele não cria nem altera tabelas, equipes, permissões ou restrições.
3. Para a Agenda, preparar as tabelas novas com `scripts/migrations/20261028_clinic_agenda.sql` no banco confirmado. Essa migração foi validada localmente, mas **não foi executada no banco remoto por esta publicação**. Ela não altera mensagens, contatos ou atendimentos. As tabelas usam RLS; a conexão do backend precisa ser proprietária delas ou ter bypass autorizado de RLS.
4. Para Equipes e números, o pacote não exige uma migração nova, mas depende da estrutura de operações existente. Se o diagnóstico indicar tabelas/colunas ausentes, revisar a preparação já existente (`20261025_company_operations.sql`) conforme o diagnóstico. Não rodar migrações antigas em lote nem ativar restrições automaticamente.
5. Na EasyPanel, compilar **somente a web de produção**, branch `main`, e conferir o commit desta publicação no registro do build. As APIs alteradas são servidas pela própria web. Não é necessário recompilar o worker de campanhas ou um serviço de API separado para este pacote.

Se a estrutura da Agenda ainda não estiver disponível, apenas o módulo Agenda exibirá a orientação de preparação e a demonstração fictícia. O código não executa a migração automaticamente. Equipes e números exibirá um diagnóstico específico quando a estrutura estiver incompleta.

## Conferência após implantação

- Menu, conversas e chat interno, incluindo envio/recebimento e histórico, sem mensagens automáticas de teste.
- Equipes e números carrega antes de permitir salvar. Criar/conferir acessos apenas nos usuários de teste autorizados.
- Com a restrição ativada, usuário liberado para A por equipe vê A e não B. Liberações individuais se somam; sem liberações, não vê canais. Administrador continua com a visão completa.
- Dashboard e relatórios seguem o mesmo recorte por número.
- Agenda com profissional de teste, consulta, bloqueio e tentativa de horário duplicado. Copiar lembrete não envia nada.

## Reversão

Se necessário, reimplantar o build anterior `730bdb0` na web, sem apagar os dados novos da Agenda. Não remover tabelas como forma de rollback. Este pacote não migra números nem histórico entre empresas.

## Validação local

Executar `npm run build`, `npm run test:operations` e `node --import tsx scripts/test-sidebar-navigation.mjs`. A suíte de operações usa banco isolado e transportes fictícios; não é validação de acesso ao banco remoto. Falhas preexistentes de TypeScript devem ser distinguidas de erros novos; o histórico do projeto registra 473 diagnósticos anteriores.

Resultado desta integração: compilação concluída, 26/26 suítes de operações aprovadas e navegação aprovada com oito perfis. O diagnóstico SQL também foi exercitado em banco isolado com Agenda ausente e preparada. A checagem de tipos continua com 473 diagnósticos preexistentes; o projeto ainda não passa integralmente no TypeScript.
