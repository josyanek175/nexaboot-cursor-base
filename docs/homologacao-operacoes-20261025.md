# Homologação das seis evoluções — DEV

As alterações desta entrega destinam-se à DEV. Nenhum banco remoto foi acessado,
nenhum e-mail real foi enviado e nenhuma mensagem foi disparada na Meta durante
o desenvolvimento. A main contém somente as correções de TI e listagem já
autorizadas anteriormente.

## Preparação no EasyPanel

1. Confirmar que o banco da DEV está separado do banco da cliente em produção.
2. Fazer um backup do banco DEV antes da migração.
3. Aplicar `scripts/migrations/20261025_company_operations.sql` no banco DEV.
   Ela cria configurações, equipes, liberações e tokens de recuperação; adiciona
   estado ativo aos grupos e invalidação de sessões após mudança de senha.
   Não cria clientes, não modifica senhas existentes e não envia mensagens.
4. Implantar a branch `dev` no serviço `nexaboot-web-dev`.
5. Atualizar também o código do worker DEV quando for validar o encerramento de
   campanhas. A manutenção usa o pool existente, em lotes de até 50 conversas,
   sem criar outro worker de envio.

## Configuração de e-mail no serviço web DEV

```env
APP_PUBLIC_URL=https://nexaboot-web-dev-nexaboot-web-dev.wa09jl.easypanel.host
SMTP_HOST=servidor-do-provedor
SMTP_PORT=587
SMTP_USER=usuario-do-provedor
SMTP_PASSWORD=senha-do-provedor
SMTP_FROM=NexaBoot <remetente-autorizado@seu-dominio>
```

Use um remetente autorizado pelo provedor. Porta 465 usa TLS direto; nas demais
portas o cliente exige STARTTLS. Não colocar esses valores em variáveis VITE.
Sem configuração válida, a recuperação informa indisponibilidade; não simula
envio bem-sucedido. Falhas de entrega são registradas sem token ou senha.

A rota emergencial antiga fica desativada por padrão. Não é necessária para a
recuperação por e-mail. Ela exige habilitação expressa e token próprio, sem usar
SESSION_SECRET como senha de manutenção.

## Roteiro para validar amanhã

1. **SUPER_ADMIN e TI:** SUPER_ADMIN cria empresas A e B com plano e administrador.
   TI seleciona cada uma, gerencia usuários e canais e mantém sua própria identidade.
   TI não cria empresas e não pode conceder nem modificar uma conta SUPER_ADMIN.
2. **Isolamento:** criar usuários distintos em A e B; conferir usuários, contatos,
   histórico e mídia. Tentar acessar IDs de B autenticado como usuário de A deve
   resultar em bloqueio, sem alterar dados de B.
3. **Equipes e números:** em A, liberar X diretamente para um atendente; liberar Y
   para sua equipe. Ativar a restrição em Configurações e conferir acesso X + Y.
   Remover da equipe deve retirar Y e preservar X; revogar a liberação individual
   deve bloquear X, inclusive envio e mídia. A restrição vem desativada para não
   bloquear os usuários existentes antes do cadastro das liberações.
4. **Fluxo Meta:** usar número de teste da Meta, sem reutilizar a ligação de produção.
   Conferir boas-vindas, botões e ações. Assumir a conversa interrompe o bot.
   Encerrar e enviar nova mensagem deve iniciar outro ciclo, preservando histórico.
   Conferir clique em botão, resposta digitada e mensagem de mídia enquanto aguarda.
5. **Alertas:** administrador ajusta prazos em Configurações. Padrões: 10 minutos
   aguardando atendente e 24 horas aguardando cliente. Novas mensagens do cliente
   não reiniciam o prazo da primeira mensagem ainda não respondida. O aviso mostra
   pendências; não encerra atendimentos humanos.
6. **Campanhas:** após aplicar a migração, habilitar no processo que executa o tick
   do worker DEV:

   ```env
   ATTENDANCE_MAINTENANCE_ENABLED=true
   ```

   No modo direct, fica no serviço do worker; no modo HTTP, fica no web que atende
   o tick. Apenas campanhas sem resposta por 24 horas e sem atendimento humano
   encerram automaticamente. Resposta, atribuição humana ou resposta pelo WhatsApp
   Business App impedem o encerramento. Resposta posterior inicia novo ciclo.
   Há tolerância de processamento do worker; o fechamento não ocorre no segundo
   exato. O recurso fica desligado até essa habilitação.
7. **Grupos:** criar grupo com membros reais; conferir na Comunicação Interna, em
   outro navegador e após recarregar. Editar nome e membros e desativar grupo.
   Desativado impede novos envios. Os antigos grupos de demonstração do navegador
   não são importados automaticamente para o banco.
8. **Senha:** solicitar e-mail real, abrir link e definir senha. Repetir o mesmo link
   deve falhar. Links expiram após 30 minutos; solicitar outro invalida o anterior.
   A troca invalida as sessões anteriores. E-mail inexistente recebe a mesma
   resposta genérica. Há limite de três solicitações por conta por hora.

## Verificação local reproduzível

```sh
npm ci
npm run test:operations
npm run build
```

A suíte usa PostgreSQL PGlite local e descartável, handlers reais e transportes
falsos de HTTP/SMTP. Não usa DATABASE_URL real. O teste de regressão de listagem
mantém o comportamento de fragmentos SQL adiados do driver postgres.js.
O Bun lockfile também foi validado em modo congelado, sem rede.

## Limites da validação

Os testes não certificam entrega na Meta, recebimento em caixa de e-mail real,
webhooks externos, volumes de anexos, vários processos PostgreSQL concorrentes
ou desempenho com carga de produção. A checagem global de tipos da base possui
erros anteriores; ela não deve ser confundida com a compilação de implantação.
Ver o laudo para achados e pendências.

Não aplicar esta migração nem publicar o pacote completo em produção antes da
homologação. Caso se volte para uma versão anterior depois de ativar as liberações,
ela não aplicará as novas restrições de números; o retorno exige controle dos
acessos. O banco adicionado deve ser preservado.
