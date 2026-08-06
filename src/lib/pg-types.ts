/**
 * Tipo do cliente postgres.js — sem importar o singleton do web.
 */
import type postgres from "postgres";

export type PgSql = ReturnType<typeof postgres>;
