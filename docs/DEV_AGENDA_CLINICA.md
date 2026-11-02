# Agenda da clínica — piloto de desenvolvimento

## Para validar amanhã

1. Na EasyPanel, compilar **somente a web de desenvolvimento**, na branch `dev`.
2. Entrar como administrador de uma empresa e abrir **Agenda da clínica** no menu (`/agenda`).
3. Sem preparar o banco, a tela informa que a agenda não está disponível e permite **Conhecer com dados fictícios**. Essa demonstração funciona só na memória da aba: não grava, não busca contatos reais e não envia mensagens.
4. Para gravar consultas reais de teste, confirmar primeiro qual conexão pertence efetivamente ao ambiente dev e aplicar nesse banco `scripts/migrations/20261028_clinic_agenda.sql`. **Não identificar o ambiente apenas pelo nome do banco**: neste projeto um nome contendo `dev` já foi usado na produção. A migração não foi executada por esta entrega em nenhum banco remoto.
5. Cadastrar um profissional com expediente e dias da semana; criar uma consulta; editar o status; tentar reservar o mesmo horário; cancelar e reservar novamente. Conferir também o celular e a aba Confirmações.

Não compilar produção, não alterar main e não executar a migração no banco da produção para este piloto. A API é servida pela própria web; não exige compilar um serviço de API separado.

## O que está pronto

- Agenda por dia e por sete dias, filtros de profissional e paciente, indicadores de consultas e confirmações.
- Cadastro de profissionais com especialidade, expediente, dias disponíveis e duração padrão.
- Consultas e bloqueios de horário; edição/remarcação, cancelamento, chegada, conclusão e falta.
- Busca opcional de contatos existentes. Cadastro avulso na agenda não cria nem duplica contatos do WhatsApp.
- Horários livres sugeridos e validação definitiva no servidor. Horários explicitamente em Brasília (`America/Sao_Paulo`), armazenados como horário civil nesse fuso.
- Mensagem neutra de lembrete para copiar manualmente; o texto evita especialidade ou procedimento. Copiar não marca envio nem confirmação.
- Dados persistidos com `company_id` derivado da sessão, sem aceitar empresa do navegador. Profissional e contato são verificados dentro da mesma empresa.
- Acesso piloto restrito a SUPER_ADMIN, TI, ADMIN_GERAL e ADMIN_EMPRESA, com empresa operacional válida. Recepção/atendentes ainda não recebem acesso: a política por equipe/número deve ser definida antes de ampliar.
- RLS habilitada sem políticas públicas nas tabelas novas; acesso pelo backend com conexão privilegiada (proprietário das tabelas ou role com bypass de RLS). Não expor esse acesso ao navegador.

## Proteções e limites desta versão

As escritas são serializadas por empresa com trava transacional PostgreSQL e conferência de sobreposição, incluindo bloqueios. Repetição da criação com o mesmo identificador não duplica; edição exige versão atual. Cancelar preserva o registro e libera o horário. Consultas não canceladas continuam ocupando o intervalo, inclusive as concluídas.

O código não cria tabelas automaticamente. Ausência de schema resulta em erro orientativo somente na agenda. Não há alteração no webhook, fluxo, worker, mensagens ou atendimentos existentes.

Ainda não há agendamento pelo próprio paciente, integração com o construtor de fluxos, confirmação automática por botão, envio automático de lembretes, agenda Google, recorrência, lista de espera ou edição do expediente já cadastrado. A seleção de antecedência registra a intenção do lembrete; não cria um job de envio. Esses são próximos passos após validar o piloto. Esta é uma agenda administrativa, não um prontuário; não cadastrar diagnósticos ou exames.

## Validação técnica

`node --import tsx scripts/test-clinic-agenda.mjs` usa PostgreSQL embarcado isolado (PGlite), sem conexão de produção ou transporte externo. Cobre migração idempotente, isolamento entre duas empresas, referência estrangeira, sobreposição, horários adjacentes, expediente, finais de semana, bloqueio, cancelamento, versão obsoleta, criação repetida, duas tentativas simultâneas e fuso/data inválida. Também exercita a API com autenticação, bloqueio de perfil/empresa, limite de período, payload inválido e schema ausente (401/403/422/503).

O teste simultâneo usa transações do banco embarcado; a disputa entre múltiplos processos PostgreSQL de produção não foi simulada. A proteção no servidor usa a trava transacional da conexão PostgreSQL real. A validação visual usa os componentes reais em prévia local com dados fictícios, sem mensagens externas. Compilação e suíte de regressão devem passar antes do push. O projeto tem 473 diagnósticos de TypeScript preexistentes; não confundir essa dívida com aprovação integral do verificador de tipos.
