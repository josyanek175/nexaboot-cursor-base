# Ciclos de atendimento Meta e nome do perfil

A implementação parte de `origin/main` em `157e854`. Não inclui as alterações locais não commitadas da branch `dev`.

## Comportamento

- O parser existente associa `contacts[].profile.name` ao remetente por `wa_id`.
- O perfil é persistido em `contacts.whatsapp_profile_name`. Nomes manuais continuam preservados. A personalização usa nome cadastral, perfil e, por último, texto sem nome. `name`/`name_source` continuam compatíveis com o cadastro existente.
- Mensagens Meta recebidas reutilizam somente conversas `open`/`waiting`. Se houver apenas atendimentos encerrados, criam outro ID. As mensagens históricas não são movidas.
- O contato é bloqueado durante a resolução do ciclo. A identidade da mensagem é consultada por empresa, canal e ID externo antes da criação de um ciclo, inclusive em reentregas de mensagens antigas.
- Contato, atendimento, mensagem, contador de não lidas e tarefa de automação são confirmados na mesma transação. O envio externo ocorre depois do commit.
- Tarefas são processadas em ordem por atendimento, com claim e lease no banco para coordenar várias réplicas. A execução imediata é complementada por um pump a cada 15 segundos no processo web, iniciado na primeira requisição. Falhas ficam em retry por 30 segundos; o lease é renovado a cada 30 segundos.
- Sessões encerradas ou transferidas não reiniciam no mesmo ciclo. A primeira mensagem com mídia pode iniciar o fluxo; mídia durante uma etapa aguardando resposta não é interpretada como resposta textual.
- A automação verifica atribuição humana ativa e estado do atendimento antes de processar e novamente antes do envio. O encerramento desativa atribuições e termina a sessão do fluxo.
- Echo do Business App é saída, não incrementa não lidas, não executa o fluxo e não reabre atendimento. Sem histórico, fica em conversa finalizada para armazenar a saída; uma mensagem posterior do cliente inicia o próprio ciclo.
- Erros de persistência retornam HTTP 503 para permitir retry da Meta. Erro da automação após commit é recuperado pela fila e não exige regravar a mensagem.

## Preparação operacional (não executada em produção)

Aplicar explicitamente `scripts/migrations/20261020_attendance_lifecycle.sql` antes de liberar esta versão. O runtime de produção verifica a estrutura, sem executar a nova migração automaticamente. O bootstrap de desenvolvimento inclui a estrutura nova.

A migração:

1. Remove o índice antigo proposto que impedia múltiplos atendimentos finalizados, caso tenha sido instalado manualmente.
2. Acrescenta o perfil e a fila de automação.
3. Garante unicidade de atendimento ativo por empresa/canal/contato. Se já houver duplicados ativos, falha de forma transacional, sem mesclar histórico. A consulta de auditoria está no início do arquivo; os casos existentes devem ser tratados antes da liberação.
4. Preenche o perfil legado somente quando `name_source = 'whatsapp'`.

O bootstrap de deduplicação passou a considerar apenas atendimentos ativos. Atendimentos encerrados não são consolidados por essa rotina.

A mudança é direcionada à entrada Meta. Os consumidores legados do CRM e a entrada Evolution mantêm o comportamento de resolução anterior; a unicidade ativa também protege a tabela compartilhada.

## Validação reproduzível

Instalar as dependências com `npm ci`. Criar um PostgreSQL local descartável e um banco vazio cujo nome termine com `_test`.

```powershell
$env:ATTENDANCE_TEST_DATABASE_URL='postgres://attendance_test@127.0.0.1:55473/attendance_lifecycle_test'
node scripts/test-attendance-lifecycle.mjs
```

O teste recusa host não local e nome de banco fora do padrão. Usa PostgreSQL real para transações, locks, concorrência, fila e migração. Apenas autenticação e serviços externos são substituídos; o provedor simulado grava as saídas na tabela de mensagens.

Os 12 cenários cobrem perfil novo, nome cadastral, atualização/vazio, continuidade open/waiting, encerramento/histórico, replay entre ciclos, concorrência, rollback, retry de envio, mídia inicial, atendimento humano e isolamento/echo. Inclui reaplicação da migração duas vezes. Esses são os cenários propostos no diagnóstico: a referência original recuperada estava truncada.

## Limites conhecidos

A fila oferece reprocessamento durável, não uma garantia de entrega exatamente uma vez no provedor externo. Se houver queda depois de a Meta aceitar o envio e antes de o resultado ser persistido, a recuperação pode reenviar. Confirmar uma falha de rede ambígua exige conciliação com os registros da Meta. As verificações de atendimento humano reduzem a corrida com o envio, mas uma chamada externa já em andamento não pode ser desfeita.

A suíte de integração não envia WhatsApp real. A validação ponta a ponta com a Meta deve ser feita em homologação depois da preparação do banco, sem disparos reais a clientes durante testes.

## Resultado da validação desta entrega

- 12/12 cenários de integração passaram em PostgreSQL 17 local. Incluem mensagens concorrentes com variantes do nono dígito, entrega duplicada concorrente, índice único ativo, lease expirado, sessão encerrada, isolamento entre canais da mesma empresa, rotina real de deduplicação e migração reaplicada duas vezes.
- Build completo de produção passou (cliente, SSR e Nitro). A tentativa inicial atingiu o limite de memória; a execução isolada com `RAYON_NUM_THREADS=1` e heap de 2048 MB concluiu.
- ESLint passou nos quatro módulos novos de atendimento e no CRM compartilhado.
- Nove suítes existentes de parser/inbound Meta, coexistência, compatibilidade Cloud API, fluxos e templates passaram. O teste de extração usa `npx tsx`, conforme seu próprio cabeçalho.
- TypeScript global: 550 erros na base original e 532 nesta versão, sem novos diagnósticos em comparação normalizada por arquivo/mensagem. Os erros restantes pertencem à base existente.
- `test-fase2-attendance.mjs` falha na expectativa antiga de polling de 5 segundos; a mesma falha foi reproduzida na base original, sem as alterações desta entrega.
- Não houve teste com o provedor real, migração de produção ou deploy.
