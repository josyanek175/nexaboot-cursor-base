# Preparação manual de Agenda e Equipes e números

Arquivo: `20261102_prepare_agenda_team_access.sql`.

Usar somente para o diagnóstico confirmado de ausência das seis tabelas novas no banco `nexabootprincipal`. Confirmar servidor e banco na conexão da web de produção e ter backup recuperável antes de executar. O nome do banco sozinho não comprova o servidor.

Este é um script de criação, diferente do diagnóstico `scripts/diagnostics/20261102_release_preflight.sql`, que apenas consulta. Publicar ou compilar a web não executa nenhum desses arquivos.

No DBeaver, abrir o arquivo completo e usar a execução de script inteiro. Não executar apenas a instrução sob o cursor. O fluxo deve chegar do `BEGIN` ao `COMMIT` e à consulta final. Não deixar uma transação aberta entre etapas. Havendo erro, interromper, encerrar a transação com `ROLLBACK` e enviar o primeiro erro, sem repetir ou adaptar o arquivo.

O arquivo cria quatro tabelas de operações e duas de Agenda, com índices e chaves estrangeiras. Adiciona dois índices às tabelas existentes users/whatsapp_channels para sustentar os vínculos por empresa. Não apaga nem atualiza registros existentes, não cria usuários, não transfere números e não ativa restrições. RLS da Agenda permanece habilitada; a conexão usada pelo backend precisa ter as permissões adequadas.

Proteções: nome do banco obrigatório, tipos UUID dos pré-requisitos, recusa se alguma das seis estruturas já existir, limite de espera por trava e limite de duração por instrução. Essas proteções não substituem a conferência da conexão e o backup. Uma falha exige rollback; não tentar contorná-la removendo as verificações.

Na consulta final, os seis campos precisam conter nomes de tabelas, sem NULL. Repetir a consulta de leitura após a execução confirma a persistência. Só depois conferir a tela e cadastrar as liberações antes de ativar a restrição por número.

Teste: `node --import tsx scripts/test-prepare-team-agenda.mjs`. Usa PGlite isolado, sem DATABASE_URL externa. Confere bloqueio de banco incorreto, rollback de falha forçada, criação limitada, preservação dos registros fictícios das seis tabelas existentes, restrição desligada, RLS da Agenda e recusa de repetição.
