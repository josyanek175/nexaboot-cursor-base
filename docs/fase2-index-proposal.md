# FASE 2 — desempenho atendimento (45 usuários) — proposta de índice

## Índice proposto (NÃO aplicado)

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_company_last_message
  ON public.conversations (company_id, last_message_at DESC NULLS LAST);
```

### Por quê

A listagem padrão ordena por `last_message_at DESC` filtrando `company_id`
(`conversations-query.server.ts`). O índice atual `idx_conversations_company (company_id)`
não cobre a ordenação.

### Como validar antes de criar

```bash
DATABASE_URL=... node scripts/explain-conversations-queries.mjs
# Produção read-only: ALLOW_PROD_EXPLAIN=1
```

Só criar o índice se o EXPLAIN mostrar Seq Scan / Sort caro e o plano com índice
composto reduzir custo. Preferir `CONCURRENTLY` em produção.

### Não fazer nesta FASE 2

- Não rodar CREATE INDEX automaticamente
- Não migration no deploy desta branch sem aprovação do EXPLAIN
