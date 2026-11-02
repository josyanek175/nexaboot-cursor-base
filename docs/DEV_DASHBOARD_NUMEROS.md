# DEV — dashboard limitado aos números liberados

## Escopo

O painel principal, o resumo de campanhas e o relatório de tempo de espera reutilizam `allowedChannelIds`, a mesma regra do atendimento. A filtragem acontece nas consultas do servidor, antes dos cálculos e limites de resultados.

- Conversas, números, contadores, prévias, finalizações, atribuições e notificações de transferência respeitam os canais liberados.
- Campanhas e suas métricas consideram apenas os números autorizados.
- Fila de espera, histórico de atribuições, médias e agentes usam o mesmo escopo.
- Liberações individuais e por equipe se somam. Revogações passam a valer na próxima consulta.
- Restrição ligada sem liberações: listas e indicadores vazios. Administrador da empresa e suporte mantêm a regra de acesso integral da empresa selecionada.
- Restrição desligada mantém o comportamento anterior. Falha de autorização não amplia o acesso.
- Respostas usam cache privado desativado. Troca de empresa/usuário reinicia as telas; respostas antigas não substituem solicitações mais recentes e falhas removem dados anteriores.

Esta entrega é exclusiva da dev e não altera as regras do cadastro de Contatos, que continua compartilhado por empresa. Não requer migração nova nem altera permissões cadastradas.

## Teste no ambiente DEV

1. Usar uma conta de atendente de teste, com a restrição ativada e acesso a um número A, sem acesso a B.
2. Conferir que B não aparece no dashboard: número, conversa sem responsável, prévias, contadores e notificações.
3. Conferir resumo de campanhas. Para tempo de espera, usar perfil gerencial autorizado ao relatório, também limitado a A.
4. Conferir liberação por equipe e revogação; atualizar a tela após cada alteração.
5. Conferir usuário sem liberações e administrador, preservando suas políticas distintas.

A sessão atual de desenvolvimento é de administrador da empresa NexaTec e não possui canais cadastrados; ela permite conferir o carregamento, mas não comprova a restrição de um atendente com dados reais. Não criar usuários ou concessões em produção para esses testes.

## Validação local

`scripts/test-dashboard-channel-permissions.mjs`: 20 cenários com empresas, usuários, canais, campanhas, mensagens e notificações fictícias em PostgreSQL isolado.

`scripts/test-operations-suite.mjs`: 24 suítes, incluindo a regressão do dashboard por número. Compilação da aplicação e verificação dos arquivos do servidor; a formatação anterior das telas foi preservada.
