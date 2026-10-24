# Portal de Administração — primeira entrega

Esta foi a primeira entrega dentro do produto. A administração global agora está no **Portal Nexa**, módulo `/nexaboot`. Consulte `portal-nexa-integracao.md` para a configuração atual. A tela `/empresas` do produto permanece disponível conforme as permissões existentes.

## Disponível

- Empresas e respectivos planos, funcionários ativos e números cadastrados.
- Busca por nome, cadastro, edição e ativação/inativação de empresas.
- Seleção de empresa para gerenciar seus funcionários com a sessão real.
- Substituição do plano contratado por um plano ativo existente, exclusiva da plataforma.
- Cadastro, edição e inativação de funcionários, preservando o histórico existente.
- Bloqueio no servidor para administrador de empresa conceder perfis de plataforma ou alterar contas de plataforma.
- Bloqueio de alteração do próprio perfil e da própria desativação na API de usuários.

Não requer nova migração. Usa as tabelas existentes de empresas, usuários, planos e assinaturas. Não cria nem altera estruturas automaticamente nesta entrega.

## Roteiro de homologação

Antes de publicar, conferir que web e worker usam o banco de homologação e que os canais de teste estão separados dos de produção.

1. Entrar com perfil de plataforma (SUPER_ADMIN, ADMIN_GERAL ou TI) e abrir Administração.
2. Criar duas empresas de teste com administradores e e-mails diferentes, escolhendo planos existentes.
3. Abrir Funcionários em cada empresa; conferir nome da empresa no cabeçalho e listas separadas.
4. Criar, editar e desativar um funcionário de teste; conferir os totais ao retornar ao portal.
5. Entrar como ADMIN_EMPRESA: deve visualizar somente sua empresa e não deve poder alterar o plano.
6. Confirmar que o seletor de perfis da empresa não oferece SUPER_ADMIN, ADMIN_GERAL ou TI. O servidor também rejeita esses perfis.
7. Como plataforma, alterar o plano da empresa de teste e conferir o novo plano na listagem. O plano anterior é cancelado e o novo é registrado na mesma transação.
8. Conferir login, atendimento, mídia e campanha de um destinatário de teste como regressão.

## Escopo pendente

Limites de plano são informativos nesta entrega; não há bloqueio de excedentes. Trocar o plano não remove nem desativa funcionários ou canais automaticamente.

Edição do catálogo de planos, aplicação dos limites, endereços `/empresa/...`, recuperação de senha por e-mail e auditoria persistente das alterações administrativas serão entregues separadamente. A visão Gerencial de campanhas continua independente deste portal.

## Verificação local

`node scripts/test-user-management-policy.mjs`: executa políticas e handlers reais com banco simulado, sem rede ou alterações em banco. Cobre promoções indevidas, alteração de senha de conta de plataforma, desativação protegida e autorização/transação de troca de plano.

`npm run build`: compilação do aplicativo.

Não substituem homologação com contas e banco reais de teste.
