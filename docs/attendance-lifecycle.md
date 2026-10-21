# Atendimento Meta usando o fluxo existente

Versão local baseada no hotfix de produção `e0a9c8a`. Não requer novas tabelas, colunas, índices ou migrações. Os scripts anteriores de criação de fila não fazem parte desta versão e não devem ser aplicados para esta entrega.

## Comportamento

- Mensagem recebida é confirmada primeiro nas tabelas existentes `contacts`, `conversations` e `messages`. O envio do bot acontece depois do commit.
- Atendimento aberto/aguardando mantém o ciclo. Após encerramento, a próxima mensagem cria outra conversa, preservando as anteriores e suas mensagens.
- O fluxo ativo já configurado por empresa/canal é reutilizado. A personalização pelo nome foi adiada: `{{nome}}` fica vazio no atendimento, por exemplo `Olá, {{nome}}!` vira `Olá!`. Nomes cadastrais existentes são preservados.
- Não há dependência de `whatsapp_profile_name`, `message_source` ou `attendance_automation_jobs` para receber e executar o fluxo.
- A leitura/escrita da sessão usa `automation_sessions`, já existente. O avanço de etapas agora persiste `step_id` corretamente; mensagens automáticas e `goto` seguem até a próxima etapa que aguarda resposta.
- O processamento de mensagens simultâneas é coordenado por bloqueio transacional curto e metadados internos em `messages.raw_payload.__nexaFlow`. Os outros campos do payload são preservados. Nenhuma conexão fica reservada durante o envio externo.
- O controle usa estados `pending`, `processing`, `processed` e `retry` no registro da mensagem. Cada tentativa tem identificação própria e lease de dois minutos, renovado durante o trabalho. Processador que perde a posse não pode continuar enviando ou alterando a sessão.
- As saídas automáticas carregam uma chave por mensagem recebida/etapa no payload existente. Se a saída já foi persistida e salvar a sessão falhar, a nova tentativa não a reenvia.
- Bot respeita atribuição humana e encerramento antes de processar e antes de cada envio. Gravação tardia da sessão não reativa estados encerrados/transferidos.
- Echo do Business App continua como saída, sem disparar o fluxo ou reabrir atendimento. Status de entrega/leitura não iniciam conversas.
- A gravação JSON passou a enviar objetos ao driver, evitando JSON com um texto JSON dentro. Sessões legadas com esse formato são lidas e normalizadas sem migração em massa.

## Compatibilidade com índice legado

Se um índice antigo impedir a criação de outra conversa para o mesmo contato/canal, a entrada é preservada e o ciclo lógico reinicia na conversa existente, sem remover o índice ou mover/apagar mensagens. O log `ATTENDANCE_LEGACY_CYCLE_REUSED` indica esse caso. A sessão anterior é reiniciada apenas porque o atendimento estava finalizado. Nesse modo compatível o ID da conversa é reutilizado; fora dele, um novo ID é criado.

## Retentativas e limites

Falha do bot não desfaz nem bloqueia a gravação da mensagem. O trabalho fica registrado na mensagem e é retomado na próxima mensagem ou reentrega da Meta, respeitando backoff de dez segundos. Não há processo de polling nem tabela nova; se o cliente ficar em silêncio, não há retry em background nesta versão. Um trabalho abandonado é recuperável na próxima entrada após expirar seu lease.

Se a Meta aceitar um envio mas o resultado não puder ser persistido, existe uma janela de resultado ambíguo: não é possível prometer entrega exatamente uma vez no provedor externo. A chamada já em andamento também não pode ser desfeita se um humano assumir naquele instante. O teste cobre saída já gravada, falhas conhecidas antes de aceite e interrupção das etapas seguintes.

Em produção, as tabelas originais de automação são verificadas, sem criação automática de estrutura. Se elas faltarem ou o fluxo não estiver configurado, a entrada continua gravada. É necessário conferir o fluxo ativo/vínculo do canal e validar com uma conta WhatsApp de teste antes de liberar amplamente.

## Validação reproduzível

`node scripts/test-attendance-lifecycle.mjs` usa PostgreSQL real e os módulos reais de ingresso Meta, roteamento, envio, persistência e sessões. Somente autenticação, configuração de canal e o provedor externo são simulados. O teste recusa host não local e banco cujo nome não termine em `_test`.

Definir `ATTENDANCE_TEST_DATABASE_URL` para um banco local vazio e descartável; opcionalmente `ATTENDANCE_TEST_POOL_MAX=1` para validar o pool mínimo. O teste cria somente fixtures das tabelas preexistentes. Inclui 55 cenários, 100 mensagens simultâneas, vinte entregas do mesmo wamid, três rodadas extras de concorrência e dois processos Node independentes sobre o mesmo banco.

Nenhuma operação dessa validação acessa produção. A aplicação continua exigindo teste final com a Meta real em homologação.
