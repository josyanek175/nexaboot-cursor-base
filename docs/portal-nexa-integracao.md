# Administração central no Portal Nexa

A administração global foi movida para o projeto Portal Nexa, módulo `/nexaboot`. A navegação do NexaBoot mantém Empresas e Usuários para as operações autorizadas da empresa.

## Configuração da DEV

No serviço web do NexaBoot DEV, definir `NEXA_PORTAL_INTEGRATION_SECRET` com uma chave aleatória de no mínimo 32 caracteres.

Na API do Portal Nexa, definir:

- `NEXABOOT_URL=https://nexaboot-web-dev-nexaboot-web-dev.wa09jl.easypanel.host`
- `NEXABOOT_INTEGRATION_SECRET` com exatamente a mesma chave.

Os arquivos `.env` locais dos dois projetos já possuem a chave. Ela está fora do Git e não deve ser enviada em mensagens ou capturas de tela. As variáveis do EasyPanel precisam ser configuradas separadamente. Não usar prefixo `VITE_` para segredos.

Implantar primeiro a branch dev do NexaBoot, depois a API e o web do Portal Nexa. Esta entrega não executa migrações e não altera produção.

## Contrato

`POST /api/internal/portal` aceita somente requisições assinadas com HMAC-SHA256. A assinatura cobre timestamp, nonce, método HTTP, caminho e corpo bruto, separados por uma quebra de linha. Cabeçalhos: `x-nexa-timestamp`, `x-nexa-nonce`, `x-nexa-signature`.

O relógio dos servidores deve estar sincronizado: a janela aceita é de 60 segundos. Nonces são mantidos temporariamente em memória para rejeitar repetição no mesmo processo. Nesta fase usar uma réplica; deduplicação compartilhada entre réplicas ainda não existe. Ausência de chave desativa a integração com status 503.

Ações disponíveis: `overview`, `createCompany`, `updateCompany`, `assignPlan`, `listUsers`, `createUser`, `updateUser`. O endpoint não fornece SQL genérico, exportação de hashes nem operações sobre mensagens.

Todas as edições de funcionários exigem a empresa e o usuário dentro dela. A integração não cria perfis de plataforma nem altera contas existentes de plataforma. Não permite desativar ou rebaixar o último administrador ativo da empresa. O estado inativo preserva os registros existentes. As operações de empresa/plano e usuário usam transações onde necessário.

Limites de plano continuam informativos. A trilha persistente de auditoria e o endurecimento de todas as rotas administrativas legadas ainda são etapas futuras. O segredo permite gestão ampla de empresas: fica exclusivamente no servidor do Portal Nexa.

## Testes

`node scripts/test-portal-integration.mjs`: assinatura, corpo adulterado, horário expirado/futuro, repetição e chave ausente/incorreta.

`node scripts/test-user-management-policy.mjs`: proteções das APIs de usuários e troca de plano.

No Portal Nexa, `pnpm build` e `pnpm test` validam API e interface sem iniciar o banco real. A conexão ao ambiente hospedado depende das duas implantações e das variáveis do EasyPanel.
