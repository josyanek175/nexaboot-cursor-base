# Evoluções do NexaBoot

Ordem combinada: item 6, depois item 1 e, em seguida, itens 2 a 5.
Uma implementação só será considerada concluída após os testes e a homologação.
As alterações começam na DEV; a produção não é o ambiente de teste.

## 6 — TI e gestão das empresas — aguardando homologação na DEV

TI deve listar e criar empresas, selecionar uma empresa e atuar com poderes de
administrador dentro dela, preservando a identidade do usuário TI.

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

Validação pendente: homologar com login TI, criação de empresa e administrador,
troca entre empresas, gestão de usuários, reset administrativo de senha e canais
Meta. Confirmar separação do banco DEV antes de criar dados de teste.

## 1 — Fluxo automático Meta — próximo

- Testar boas-vindas, botões, ações e retomada após encerrar uma conversa.
- Nova mensagem após encerramento inicia novo ciclo, preservando o histórico.
- Alertas configuráveis pelo administrador da empresa: aguardando atendente,
  padrão de 10 minutos; aguardando cliente, padrão de 24 horas.
- Conversas humanas recebem alertas, sem encerramento automático por essa regra.
- Campanha sem resposta encerra após 24 horas do envio, desde que não tenha sido
  assumida por atendimento humano. Resposta posterior inicia novo ciclo.
- Remover a opção Evolution da interface, mantendo o fluxo existente no código.

## 2 — Permissões de números — pendente

Liberar números individualmente ou por equipe. As permissões efetivas somam
as liberações individuais e as das equipes do usuário, inclusive no servidor.

## 3 — Laudo de falhas — diagnóstico inicial realizado

Investigar e reproduzir falhas, incluindo grupos internos. Separar defeitos
confirmados, falhas reproduzidas e funcionalidades ainda não implementadas.
O diagnóstico inicial encontrou dados de demonstração no fluxo de grupos.

## 4 — Recuperação de senha por e-mail — pendente

Envio real de e-mail e link com prazo de validade e uso único.

## 5 — Validação completa de empresas — pendente

Mapear e testar isolamento de dados e permissões em todo o fluxo de empresas.
Usar duas empresas de teste em ambiente separado, após a correção da TI.
Não considerar o isolamento completo validado apenas pelos testes do item 6.
