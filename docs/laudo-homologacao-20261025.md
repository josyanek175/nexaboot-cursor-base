# Laudo de validação do NexaBoot — 25/10/2026

Escopo: revisão do código da DEV e testes locais isolados. Este laudo registra
defeitos confirmados e a cobertura dos testes; não é uma certificação de que
100% do sistema funciona em produção.

## Defeitos confirmados e tratados

- **Seed público de demonstração — impacto crítico:** a rota antiga de seed não
  exigia autenticação e podia substituir usuários e senhas existentes. Desativada
  completamente na DEV (GET/POST retornam 410 sem acessar banco). Essa correção
  deve receber prioridade na publicação; a main permanece sem esta entrega até
  autorização. Não foi realizado teste contra um ambiente publicado e não há
  evidência, nesta análise, de que alguém tenha utilizado a rota.
  Correção separada no commit `0587d32`, com teste independente
  `scripts/test-public-admin-guards.mjs`, para permitir publicação sem migração.
- **Diagnósticos públicos — impacto alto:** diagnósticos globais de banco,
  planos e canal Meta não exigiam perfil de plataforma e podiam mostrar usuários
  e informações de várias empresas. Agora exigem sessão ativa TI/SUPER_ADMIN/
  ADMIN_GERAL antes de consultar dados. Testados bloqueio anônimo e de atendente.
- **Listagem de empresas — impacto alto:** subconsulta assíncrona executava o
  fragmento de contagem fora da consulta externa, gerando `missing FROM-clause
  entry for table c`. Corrigida e já publicada separadamente conforme autorização.
- **Contexto TI — impacto alto:** interface misturava tenant antigo e dados de
  demonstração com a empresa selecionada. Corrigido contexto e recarga das telas.
- **Grupos internos — impacto alto:** tela gerencial gravava no navegador e usava
  usuários fictícios. Substituída por grupos e membros reais no banco e mesma
  Comunicação Interna; criação e membros passam a ser transacionais.
- **Criação de empresas — impacto alto:** TI também podia provisionar empresas.
  Na DEV, criação exclusiva do SUPER_ADMIN, protegida na API e na interface.
- **Elevação de perfil — impacto alto:** TI podia conceder SUPER_ADMIN. A DEV
  reserva essa concessão e alteração de contas SUPER_ADMIN a outro SUPER_ADMIN.
- **Gestão de canais — impacto alto:** criação/alteração de canais e remoção de
  token tinham verificações de empresa, mas faltava uniformizar o perfil gestor.
  Rotas de alteração passaram a exigir administrador/plataforma.
- **Sessões — impacto alto:** assinatura era conferida sem validar a idade do
  token no servidor. Adicionadas validade de 30 dias e rejeição de data futura.
  Migração e gate do servidor invalidam sessões anteriores após mudar a senha.
- **Reset emergencial — impacto alto:** endpoint antigo aceitava SESSION_SECRET
  como token de manutenção e uma senha padrão. Agora é desativado por padrão,
  exige segredo próprio e senha explícita. Não faz parte do fluxo normal de e-mail.

## Funcionalidades que faltavam e foram implementadas na DEV

- Envio dos botões de resposta pela Meta no pipeline existente, incluindo
  persistência e proteção de envio do fluxo. Menus repetidos/limites inválidos
  são rejeitados; opções digitadas continuam aceitas.
- Alertas configuráveis por empresa, sem encerramento automático de conversas
  humanas. Padrões de 10 minutos e 24 horas.
- Encerramento de campanhas sem resposta nem intervenção humana após 24 horas,
  habilitado explicitamente no worker após a migração.
- Equipes, membros e liberações individuais ou por equipe. Acesso é a união das
  liberações; revogação é aplicada novamente pelo servidor a cada requisição.
- Recuperação por SMTP com token opaco, hash no banco, 30 minutos, uso único,
  limite por conta e invalidação de links após mudança administrativa de senha.
- Remoção da opção Evolution na interface de canais; código do provedor preservado.

## Cobertura realizada

PostgreSQL descartável local executa as consultas e transações reais dos caminhos
principais: duas empresas, criação de empresa/admin/plano, troca TI, usuários,
contatos, histórico, mídia, envio bloqueado, permissões/equipes, grupos, recuperação,
alertas, encerramento de campanhas e reinício do fluxo. HTTP da Meta e SMTP são
substituídos por transportes falsos; nenhuma mensagem real foi enviada.

Há testes específicos de rollback de grupo, reuso de conversa direta, idempotência
do encerramento, esquema antigo com unicidade de conversa e sessões revogadas no
gate real do servidor. Os scripts ficam em `scripts/test-operations-suite.mjs`.

## Pendências e limitações concretas

- **Limites de plano:** a listagem mostra capacidade e uso, mas as rotas atuais
  de criação de usuários e canais não aplicam universalmente esses limites.
  Isso é uma lacuna confirmada da base. Não considerar o controle comercial de
  planos homologado até implementar e testar o limite também nas ativações e
  integrações; não foram introduzidos bloqueios novos que afetem a cliente atual.
- Homologar em EasyPanel após migração e configuração SMTP; validar Meta e
  recebimento de e-mails reais, botões no telefone e volume dos anexos.
- Testar carga e concorrência entre vários processos em PostgreSQL completo.
  O PGlite local não simula múltiplos workers conectados a um servidor remoto.
- A base já contém erros globais de TypeScript, principalmente na tipagem do
  wrapper SQL. Compilação bem-sucedida não equivale a typecheck global aprovado.
- `npm audit --omit=dev` apontou 20 avisos na árvore instalada: 1 moderado, 13 altos
  e 6 críticos. Os pacotes apontados não são as novas dependências de SMTP/testes.
  Parte da árvore inclui ferramentas de build declaradas como dependências;
  severidade do aviso não comprova exploração no serviço publicado. A atualização
  dessas dependências exige avaliação de compatibilidade e não foi aplicada com
  correções automáticas que poderiam quebrar o build. Evidência: relatório JSON
  de dependências desta data.
- A lista de contatos é compartilhada dentro da mesma empresa; as novas
  liberações restringem números, conversas, histórico, envio e mídia. Confirmar
  se também deve haver carteira individual de contatos, que é uma regra distinta.
- A variável `{{nome}}` permanece suprimida no fluxo de atendimento pela regra
  existente do código. Testes confirmam reinício da saudação sem alterar essa
  regra. Se a intenção for personalizar pelo nome, isso requer ajuste específico.

Os itens só devem ser considerados homologados após os testes do ambiente real.
