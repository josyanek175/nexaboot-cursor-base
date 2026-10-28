# Retorno do cliente na mesma conversa — dev

O retorno de um cliente pelo webhook Meta agora reabre a conversa finalizada do mesmo contato, empresa e canal. Não cria outro registro para cada retorno.

- Conversas abertas ou aguardando têm prioridade e mantêm seu estado, sessão e responsável.
- Sem conversa ativa, a finalizada mais recente é reaberta. Mensagens e anexos permanecem associados ao mesmo ID.
- A sessão automática é reiniciada apenas na reabertura, com respostas antigas limpas e boas-vindas do fluxo ativo do canal.
- Atribuições humanas ativas impedem o reinício automático.
- Reentregas do mesmo identificador de mensagem não reabrem o atendimento e não duplicam mensagens.
- Echo do aplicativo WhatsApp Business preserva o estado e não dispara boas-vindas.
- Os bloqueios transacionais existentes por empresa/telefone e contato serializam mensagens simultâneas.

Não exige migração, novas tabelas ou campos de nome de perfil. Publicação restrita à branch dev; compilar o serviço web da dev para validar.

Históricos já separados anteriormente permanecem preservados. Esta correção evita novas separações; não junta, apaga ou move registros antigos. Se houver vários registros finalizados, o mais recente é reutilizado.

## Verificação

- `scripts/test-attendance-lifecycle.mjs`: banco PostgreSQL descartável local, envio Meta simulado; inclui 100 mensagens concorrentes no retorno, reentregas, retornos sucessivos, ausência de sessão, estados legados, atribuição humana, coexistência e isolamento de empresa/canal.
- `scripts/test-flow-lifecycle-isolated.mjs`: motor real de fluxo, opções de botão, transferência humana e histórico acumulado na mesma conversa.
- `npm run test:operations`: regressões de fluxos, permissões e isolamento em banco isolado.
- `npm run build`: compilação web.

## Validação na interface da dev

1. Abrir um cliente no canal de teste e anotar o ID da conversa.
2. Finalizar e enviar um novo “oi” pelo WhatsApp do cliente.
3. Conferir que o mesmo ID reabriu, com histórico anterior e novas boas-vindas.
4. Responder ao botão e enviar outra mensagem: não deve surgir outra conversa nem reiniciar a saudação.
5. Assumir o atendimento e responder novamente pelo cliente: o responsável permanece e o bot não interfere.
6. Finalizar e repetir o retorno: o mesmo histórico continua sendo usado.

Testes automatizados não enviam mensagens reais, não acessam o banco da aplicação e não substituem a validação visual após compilar a dev.
