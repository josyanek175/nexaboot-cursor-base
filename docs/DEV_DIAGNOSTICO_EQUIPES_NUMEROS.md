# DEV — diagnóstico de Equipes e números

## Alteração

As APIs `/api/team-access` e `/api/company-operations` verificam, após autorizar o usuário, se as quatro tabelas de operações e as colunas utilizadas pelo recurso estão disponíveis. A verificação consulta apenas metadados do PostgreSQL; não executa DDL, não concede acesso e não ativa a restrição por canal.

Estrutura incompleta retorna JSON 503 com as tabelas/colunas ausentes. Falta de privilégio no banco, indisponibilidade de conexão e erros inesperados têm classificações distintas, sem expor SQL, credenciais, conexão ou mensagem bruta do servidor. Respostas não são armazenadas em cache.

As duas telas usam o diagnóstico específico, oferecem nova tentativa e bloqueiam os formulários enquanto os dados não carregarem. Resultados de solicitações antigas são descartados ao trocar de empresa ou sair da tela.

## Validar no ambiente DEV

1. Recompilar somente o serviço web da branch `dev`.
2. Entrar na dev e abrir Equipes e números e Configurações.
3. Se houver erro, abrir “Detalhes para o suporte” e verificar as tabelas/colunas informadas.
4. Não executar uma migração apenas com base no aviso antigo. A preparação do banco real permanece uma etapa separada, após confirmar ambiente e diagnóstico.
5. Com estrutura disponível, conferir usuários, canais, equipes e liberações existentes. Cadastro e salvamento continuam exigindo as mesmas permissões.

Endereço informado: https://nexaboot-web-dev-nexaboot-web-dev.wa09jl.easypanel.host/

## Validação local

- `scripts/test-operations-readiness.mjs`: 28 cenários com PostgreSQL isolado e renderização dos formulários.
- `scripts/test-operations-suite.mjs`: 23 suítes de regressão.
- Compilação normal da aplicação e lint dos arquivos alterados.

Nenhum banco real, permissão real, webhook ou recurso da main é alterado por esta entrega. A alteração não repara automaticamente um banco incompleto: torna a causa visível e impede gravações enquanto a estrutura estiver indisponível.
