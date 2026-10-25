# Evoluções do NexaBoot

Ordem combinada: item 6, depois item 1 e, em seguida, itens 2 a 5.
Uma implementação só será considerada concluída após os testes e a homologação.
As alterações começam na DEV; a produção não é o ambiente de teste.

## 6 — TI e gestão das empresas — aguardando homologação na DEV

TI deve listar empresas, selecionar uma empresa e atuar com poderes de
administrador dentro dela, preservando a identidade do usuário TI.
Conforme ajuste posterior do usuário, criar uma empresa é exclusivo de
SUPER_ADMIN; TI e ADMIN_GERAL não podem criar novas empresas.
O cadastro fica em Empresas → Nova empresa, com plano e administrador inicial.
Somente SUPER_ADMIN pode conceder esse perfil ou alterar outra conta SUPER_ADMIN.

Correção atual: contexto da interface baseado na empresa real selecionada,
remoção do seletor fictício de usuários, recarga ao trocar de empresa,
bloqueio operacional sem empresa válida e respostas de API sem cache.

Testes isolados aprovados: identidade TI, seleção de empresa, assinatura e
vínculo do cookie ao usuário, bloqueio de registros inativos, criação de empresa
com administrador e plano, reset de senha limitado à empresa selecionada e
recarga da interface somente após a seleção ser aceita pelo servidor.
Os testes não acessam banco real nem enviam mensagens.
Compilação aprovada. A checagem global de tipos ainda apresenta erros já
existentes na base, incluindo tipos das consultas SQL e uma ação de auditoria.

Falha encontrada durante homologação: HTTP 500 na lista de empresas. A
subconsulta de contagem de canais era retornada por uma função assíncrona e
executada antes da consulta externa que define a empresa. Correção preparada
na DEV, com teste de regressão para listagem global e por empresa, com e sem
coluna deleted_at. Confirmar a resolução no ambiente publicado.

Validação pendente: homologar com login TI e SUPER_ADMIN, criação pelo SUPER_ADMIN,
troca entre empresas, gestão de usuários, reset administrativo de senha e canais
Meta. Confirmar separação do banco DEV antes de criar dados de teste.

## 1 — Fluxo automático Meta — implementado e testado localmente

- Testar boas-vindas, botões, ações e retomada após encerrar uma conversa.
- Nova mensagem após encerramento inicia novo ciclo, preservando o histórico.
- Alertas configuráveis pelo administrador da empresa: aguardando atendente,
  padrão de 10 minutos; aguardando cliente, padrão de 24 horas.
- Conversas humanas recebem alertas, sem encerramento automático por essa regra.
- Campanha sem resposta encerra após 24 horas do envio, desde que não tenha sido
  assumida por atendimento humano. Resposta posterior inicia novo ciclo.
- Remover a opção Evolution da interface, mantendo o fluxo existente no código.

Implementação disponível na DEV: botões Meta, alertas e configuração por empresa,
encerramento de campanhas habilitado por variável do worker. Testes executam o
motor real em PostgreSQL local descartável, incluindo encerramento, novo ciclo
e saudação, histórico e intervenção humana. Falta homologar no telefone e EasyPanel.

## 2 — Permissões de números — implementado e testado localmente

Liberar números individualmente ou por equipe. As permissões efetivas somam
as liberações individuais e as das equipes do usuário, inclusive no servidor.

Tela Equipes e números e configuração para ativar a restrição, inicialmente
desativada para preservar o acesso existente. Testes cobrem união, revogação,
leitura, mídia, envio e tentativas de vincular dados de outra empresa.

## 3 — Laudo de falhas — relatório preparado; grupos corrigidos na DEV

Investigar e reproduzir falhas, incluindo grupos internos. Separar defeitos
confirmados, falhas reproduzidas e funcionalidades ainda não implementadas.
O diagnóstico inicial encontrou dados de demonstração no fluxo de grupos.
Tela substituída por grupos reais na mesma Comunicação Interna. Testados
rollback, persistência, edição, inativação e isolamento dos membros. Achados e
limitações estão em `laudo-homologacao-20261025.md`, incluindo limites de plano,
dependências e dívida de tipagem que ainda exigem trabalho.

## 4 — Recuperação de senha por e-mail — implementado; falta SMTP real

Envio real de e-mail e link com prazo de validade e uso único.
Código SMTP, tela de nova senha, hash de token, expiração, uso único e invalidação
de sessões testados com banco isolado e transporte falso. Sem envio real durante
o desenvolvimento. Configurar SMTP e validar recebimento amanhã.

## 5 — Empresas — testes dos caminhos principais aprovados; homologação pendente

Mapear e testar isolamento de dados e permissões em todo o fluxo de empresas.
Usar duas empresas de teste em ambiente separado, após a correção da TI.
Não considerar o isolamento completo validado apenas pelos testes do item 6.
Suíte adicional com duas empresas, SQL e handlers reais cobre usuários, reset,
contatos, histórico, mídia, envio, canais liberados e troca TI. Ainda não há
certificação de 100% das integrações nem testes de carga concorrente em ambiente
remoto. O controle universal dos limites de plano permanece como lacuna do laudo.

## Entrega para homologação

Resultado local: 23/23 suítes e compilação aprovadas. Comparação de tipos contra
`0e4a125` sem novos locais de erro (527 na base, 504 atuais). A revisão encontrou
rotas públicas antigas com risco crítico; o bloqueio está separado em `0587d32`
para publicação prioritária sem migração ou novas funcionalidades.

Consultar `homologacao-operacoes-20261025.md` antes de implantar: migração DEV,
SMTP e ativação expressa da manutenção de campanhas. Nada desta entrega completa
foi aplicado automaticamente na produção.
