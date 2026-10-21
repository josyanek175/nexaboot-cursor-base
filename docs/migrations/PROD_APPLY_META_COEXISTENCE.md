# Procedimento PROD — Meta Coexistence (schema)

**Não executar automaticamente.** Console EasyPanel preferencial:  
`nexabootprincipal` → **`nexaboot-evolution-db`**  
Database: `nexabootprincipal` · Host interno: `nexabootprincipal_nexaboot-evolution-db`

## Ordem obrigatória (produção)

1. `docs/migrations/20260803_meta_connection_mode_nullable.sql`  
   (**não** aplicar `20260801_meta_connection_mode.sql` em produção)
2. `docs/migrations/20260801_meta_coexistence_onboarding.sql`
3. `docs/migrations/20260802_meta_coexistence_connected_at.sql`

Arquivo histórico `20260801_meta_connection_mode.sql` permanece no repo (NOT NULL DEFAULT) e **não** entra neste procedimento de PROD.

---

## 1. Confirmar container

```bash
hostname
command -v psql
command -v pg_dump
psql --version
pg_dump --version
```

## 2. Identidade do banco (sem senha)

```bash
psql -U postgres -d nexabootprincipal -v ON_ERROR_STOP=1 -c \
  "SELECT current_database() AS db, current_user AS usr, inet_server_addr() AS addr, inet_server_port() AS port, now() AS ts;"
```

Abortar se `db` ≠ `nexabootprincipal` ou se for o legado `nexaboot`.

## 3. Backup completo + download externo

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR=/tmp/nexaboot_coex_backup_${STAMP}
mkdir -p "$BACKUP_DIR"
echo "BACKUP_DIR=$BACKUP_DIR"

pg_dump -U postgres -d nexabootprincipal -Fc \
  -f "${BACKUP_DIR}/nexabootprincipal_pre_coex_${STAMP}.dump"
echo "pg_dump_full_exit=$?"
ls -lh "${BACKUP_DIR}/nexabootprincipal_pre_coex_${STAMP}.dump"
```

Baixar o `.dump` para fora do container **antes** de continuar. Só seguir se `pg_dump_full_exit=0`.

## 4. Backup `whatsapp_channels`

```bash
pg_dump -U postgres -d nexabootprincipal -Fc \
  -t public.whatsapp_channels \
  -f "${BACKUP_DIR}/whatsapp_channels_pre_coex_${STAMP}.dump"
echo "pg_dump_channels_exit=$?"
ls -lh "${BACKUP_DIR}/whatsapp_channels_pre_coex_${STAMP}.dump"
```

Baixar também este arquivo.

## 5. Snapshot “Antes” (mesmas colunas, `ORDER BY id`)

```bash
BEFORE_FILE="${BACKUP_DIR}/before_${STAMP}.txt"

psql -U postgres -d nexabootprincipal -v ON_ERROR_STOP=1 -o "$BEFORE_FILE" <<'SQL'
\echo '=== IDENTITY ==='
SELECT current_database() AS db, current_user AS usr, inet_server_addr() AS addr, inet_server_port() AS port, now() AS ts;

\echo '=== COLUMNS coexistence ==='
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'whatsapp_channels'
  AND column_name IN (
    'meta_connection_mode','token_expires_at','embedded_signup_config_id',
    'coexistence_status','onboarding_completed_at','history_sync_status',
    'history_sync_started_at','history_sync_completed_at',
    'webhook_subscription_status','app_business_id',
    'connected_at','webhook_subscribed_at'
  )
ORDER BY column_name;

\echo '=== TEMP TABLES ==='
SELECT to_regclass('public.meta_coexistence_onboardings') AS onboardings,
       to_regclass('public.meta_coexistence_csrf_states') AS csrf;

\echo '=== CHANNEL SNAPSHOT ==='
SELECT id, company_id, channel_type, status, active,
       phone_number_id, waba_id, deleted_at
FROM public.whatsapp_channels
ORDER BY id;

\echo '=== COUNTS BY channel_type ==='
SELECT channel_type, count(*) AS n,
       count(*) FILTER (WHERE active) AS active_n
FROM public.whatsapp_channels
WHERE deleted_at IS NULL
GROUP BY 1
ORDER BY 1;
SQL

echo "before_sql_exit=$?"
ls -lh "$BEFORE_FILE"
```

Baixar `before_*.txt`.

## 6. Localizar SQL no container

```bash
find / -type f -name '20260803_meta_connection_mode_nullable.sql' 2>/dev/null | head
find / -type f -name '20260801_meta_coexistence_onboarding.sql' 2>/dev/null | head
find / -type f -name '20260802_meta_coexistence_connected_at.sql' 2>/dev/null | head
```

No Postgres EasyPanel os arquivos do repo **em geral não estão montados**. Alternativas:

- copiar os 3 arquivos para `/tmp` no container; ou
- executar o conteúdo integral via `psql` heredoc / Query (a partir do repo).

**Não** aplicar `20260801_meta_connection_mode.sql`.

## 7. Aplicar (ordem fixa, `ON_ERROR_STOP=1`)

```bash
# Exemplo com arquivos em /tmp — ajuste o path se necessário
psql -U postgres -d nexabootprincipal -v ON_ERROR_STOP=1 \
  -f /tmp/20260803_meta_connection_mode_nullable.sql
echo "mig1_exit=$?"
# Parar se ≠ 0. Não rodar rollback sem autorização.

psql -U postgres -d nexabootprincipal -v ON_ERROR_STOP=1 \
  -f /tmp/20260801_meta_coexistence_onboarding.sql
echo "mig2_exit=$?"

psql -U postgres -d nexabootprincipal -v ON_ERROR_STOP=1 \
  -f /tmp/20260802_meta_coexistence_connected_at.sql
echo "mig3_exit=$?"
```

Após cada arquivo: confirmar exit `0`. No primeiro erro: interromper; não corrigir automaticamente; não rollback sem autorização.

## 8. Snapshot “Depois” + diff + validações

```bash
AFTER_FILE="${BACKUP_DIR}/after_${STAMP}.txt"

psql -U postgres -d nexabootprincipal -v ON_ERROR_STOP=1 -o "$AFTER_FILE" <<'SQL'
\echo '=== IDENTITY ==='
SELECT current_database() AS db, current_user AS usr, now() AS ts;

\echo '=== NEW COLUMNS ==='
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='whatsapp_channels'
  AND column_name IN (
    'meta_connection_mode','token_expires_at','embedded_signup_config_id',
    'coexistence_status','onboarding_completed_at','history_sync_status',
    'history_sync_started_at','history_sync_completed_at',
    'webhook_subscription_status','app_business_id',
    'connected_at','webhook_subscribed_at'
  )
ORDER BY column_name;

\echo '=== TEMP TABLES ==='
SELECT to_regclass('public.meta_coexistence_onboardings') AS onboardings,
       to_regclass('public.meta_coexistence_csrf_states') AS csrf;

\echo '=== CHANNEL SNAPSHOT ==='
SELECT id, company_id, channel_type, status, active,
       phone_number_id, waba_id, deleted_at
FROM public.whatsapp_channels
ORDER BY id;

\echo '=== COUNTS + meta_connection_mode ==='
SELECT channel_type, meta_connection_mode, count(*) AS n,
       count(*) FILTER (WHERE active) AS active_n
FROM public.whatsapp_channels
WHERE deleted_at IS NULL
GROUP BY 1, 2
ORDER BY 1, 2;

\echo '=== VALIDATE meta_connection_mode nullable / no default ==='
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'whatsapp_channels'
  AND column_name = 'meta_connection_mode';

\echo '=== VALIDATE constraint definition ==='
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conname = 'whatsapp_channels_meta_connection_mode_check';

\echo '=== VALIDATE Evolution NULL ==='
SELECT count(*) AS evolution_non_null_mode
FROM public.whatsapp_channels
WHERE deleted_at IS NULL
  AND lower(channel_type) = 'evolution'
  AND meta_connection_mode IS NOT NULL;

\echo '=== VALIDATE Meta cloud_api (não coexistence) ==='
SELECT count(*) AS meta_not_cloud_api
FROM public.whatsapp_channels
WHERE deleted_at IS NULL
  AND lower(channel_type) = 'meta'
  AND coalesce(meta_connection_mode, '') IS DISTINCT FROM 'cloud_api'
  AND coalesce(meta_connection_mode, '') IS DISTINCT FROM 'coexistence';

SELECT count(*) AS meta_null_mode
FROM public.whatsapp_channels
WHERE deleted_at IS NULL
  AND lower(channel_type) = 'meta'
  AND meta_connection_mode IS NULL;
SQL

echo "after_sql_exit=$?"

awk '/^=== CHANNEL SNAPSHOT ===/{p=1;next} /^===/{if(p){exit}} p' "$BEFORE_FILE" > /tmp/before_channels.txt
awk '/^=== CHANNEL SNAPSHOT ===/{p=1;next} /^===/{if(p){exit}} p' "$AFTER_FILE"  > /tmp/after_channels.txt
diff -u /tmp/before_channels.txt /tmp/after_channels.txt || true
```

### Critérios de sucesso

| Check | Esperado |
|-------|----------|
| Diff do CHANNEL SNAPSHOT | vazio (mesmos id, company_id, channel_type, status, active, phone_number_id, waba_id, deleted_at) |
| `evolution_non_null_mode` | `0` |
| Meta ativos sem coexistence | `meta_connection_mode = cloud_api`; `meta_null_mode = 0` |
| `is_nullable` | `YES` |
| `column_default` | `NULL` (vazio) |
| Constraint | `CHECK ((meta_connection_mode IS NULL) OR (meta_connection_mode = ANY (...)))` ou equivalente com `IN` |
| Tabelas temp | `onboardings` e `csrf` não nulos |

## 9. Ainda não fazer

- Restart de serviços  
- Smoke test / Embedded Signup real  
- Alterar `META_*` / allowlist  
- Commit/deploy automático deste procedimento no app  
- Rollback sem autorização explícita  

## Rollback (somente com autorização)

Ordem inversa aproximada:

1. `20260802_meta_coexistence_connected_at_rollback.sql`
2. `20260801_meta_coexistence_onboarding_rollback.sql`
3. Remoção manual das colunas/constraint criadas por `20260803_…` (ou restore do `pg_dump`)

Preferir restore do dump completo se houver dúvida.
