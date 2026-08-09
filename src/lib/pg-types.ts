/**
 * Tipo do cliente postgres.js — sem importar o singleton do web.
 */
import type postgres from "postgres";

export type PgSql = ReturnType<typeof postgres>;

/**
 * Superfície mínima de execução de query: só a tag de template.
 *
 * Existe para que a lógica de domínio dos webhooks rode indiferente ao que
 * recebe — o pool do web (autocommit), o pool do worker ou a `TransactionSql`
 * de dentro de um `begin`. É o que permite ao message-worker agrupar tudo numa
 * transação sem duplicar o código que a rota legada já usa.
 */
// Os parâmetros aceitos pelo postgres.js são um union enorme; `any` mantém o
// tipo utilizável tanto pelo cliente real quanto pelos fakes de teste.
export type SqlExecutor = <T extends readonly unknown[] = unknown[]>(
  strings: TemplateStringsArray,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...values: any[]
) => Promise<T>;
