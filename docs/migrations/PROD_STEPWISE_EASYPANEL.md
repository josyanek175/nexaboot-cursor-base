# Execução manual passo a passo (EasyPanel Console)

Serviço: `nexabootprincipal` → `nexaboot-evolution-db`  
Database: `nexabootprincipal` · User: `postgres`

**Não** usar `MODE=APPLY` de uma vez. Ordem: BACKUP → download → mig1+val → mig2+val → mig3 → validação final+diff.

Copie o script e os 3 `.sql` para o container (ex.: `/tmp`) antes.

---

## Etapa 0 — Preparar arquivos no container

No Console do Postgres:

```bash
mkdir -p /tmp/nexaboot_coex_sql
ls -lh /tmp/PROD_RUN_IN_EASYPANEL.sh \
  /tmp/nexaboot_coex_sql/20260803_meta_connection_mode_nullable.sql \
  /tmp/nexaboot_coex_sql/20260801_meta_coexistence_onboarding.sql \
  /tmp/nexaboot_coex_sql/20260802_meta_coexistence_connected_at.sql
```

(Se os arquivos ainda não estiverem lá, copie-os do repo para esses paths.)

---

## Etapa 1 — MODE=BACKUP (só isso agora)

```bash
cd /tmp
MODE=BACKUP bash /tmp/PROD_RUN_IN_EASYPANEL.sh
```

**Exigido no output:**
- `identity_ok=1 db=nexabootprincipal user=postgres`
- `pg_dump_full_exit=0`
- `pg_dump_channels_exit=0`
- `BACKUP_DONE=1`
- linhas `STAMP=...` e `BACKUP_DIR=...`

**Pare.** Anote `STAMP` e `BACKUP_DIR`. Baixe os dois `.dump` para fora do container.  
**Não** rode migrations ainda.

Envie ao agente: exits + `STAMP` + `BACKUP_DIR` (sem secrets).

---

## Etapa 2 — Após download confirmado: exportar contexto

```bash
export STAMP='<colar_STAMP_do_backup>'
export BACKUP_DIR='<colar_BACKUP_DIR_do_backup>'
export MIG_DIR=/tmp/nexaboot_coex_sql
export PSQL='psql -U postgres -d nexabootprincipal -v ON_ERROR_STOP=1'

# Revalidar dumps (obrigatório)
test -s "${BACKUP_DIR}/nexabootprincipal_pre_coex_${STAMP}.dump" && echo full_dump_ok
test -s "${BACKUP_DIR}/whatsapp_channels_pre_coex_${STAMP}.dump" && echo channels_dump_ok
$PSQL -c "SELECT current_database() AS db, current_user AS usr;"
```

---

## Etapa 3 — Snapshot Antes

```bash
$PSQL -o "${BACKUP_DIR}/before_${STAMP}.txt" <<'SQL'
\echo '=== CHANNEL SNAPSHOT ==='
SELECT id, company_id, channel_type, status, active,
       phone_number_id, waba_id, deleted_at
FROM public.whatsapp_channels
ORDER BY id;
SQL
echo "before_sql_exit=$?"
ls -lh "${BACKUP_DIR}/before_${STAMP}.txt"
```

Só continue se `before_sql_exit=0`.

---

## Etapa 4 — Migration 1 + validação

```bash
$PSQL -f "${MIG_DIR}/20260803_meta_connection_mode_nullable.sql"
echo "mig1_exit=$?"
```

Se `mig1_exit != 0` → **PARE** (sem rollback automático).

Validação migration 1:

```bash
$PSQL <<'SQL'
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='whatsapp_channels'
  AND column_name='meta_connection_mode';

SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conname='whatsapp_channels_meta_connection_mode_check';

SELECT channel_type, meta_connection_mode, count(*) AS n
FROM public.whatsapp_channels
WHERE deleted_at IS NULL
GROUP BY 1, 2
ORDER BY 1, 2;

SELECT count(*) AS evolution_non_null_mode
FROM public.whatsapp_channels
WHERE deleted_at IS NULL AND lower(channel_type)='evolution'
  AND meta_connection_mode IS NOT NULL;

SELECT count(*) AS meta_null_mode
FROM public.whatsapp_channels
WHERE deleted_at IS NULL AND lower(channel_type)='meta'
  AND meta_connection_mode IS NULL;

SELECT count(*) AS coexistence_count
FROM public.whatsapp_channels
WHERE deleted_at IS NULL AND meta_connection_mode='coexistence';
SQL
echo "mig1_validate_exit=$?"
```

**Critérios para seguir:**
- `is_nullable=YES`, `column_default` vazio/NULL
- constraint permite NULL / cloud_api / coexistence
- `evolution_non_null_mode=0`
- `meta_null_mode=0`
- `coexistence_count=0` (ainda sem coexistence real)
- Meta agrupado como `cloud_api`

Envie o resultado antes da mig2.

---

## Etapa 5 — Migration 2 + validação

```bash
$PSQL -f "${MIG_DIR}/20260801_meta_coexistence_onboarding.sql"
echo "mig2_exit=$?"
```

Validação:

```bash
$PSQL <<'SQL'
SELECT to_regclass('public.meta_coexistence_onboardings') AS onboardings,
       to_regclass('public.meta_coexistence_csrf_states') AS csrf;
SQL
echo "mig2_validate_exit=$?"
```

**Critérios:** ambos não nulos. Envie output antes da mig3.

---

## Etapa 6 — Migration 3

```bash
$PSQL -f "${MIG_DIR}/20260802_meta_coexistence_connected_at.sql"
echo "mig3_exit=$?"
```

Se ≠ 0 → **PARE**.

---

## Etapa 7 — Validação final + diff

```bash
$PSQL -o "${BACKUP_DIR}/after_${STAMP}.txt" <<'SQL'
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
WHERE table_schema='public' AND table_name='whatsapp_channels'
  AND column_name='meta_connection_mode';

\echo '=== VALIDATE constraint ==='
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conname='whatsapp_channels_meta_connection_mode_check';

\echo '=== VALIDATE tables ==='
SELECT to_regclass('public.meta_coexistence_onboardings') AS onboardings,
       to_regclass('public.meta_coexistence_csrf_states') AS csrf;

\echo '=== VALIDATE Evolution NULL ==='
SELECT count(*) AS evolution_non_null_mode
FROM public.whatsapp_channels
WHERE deleted_at IS NULL AND lower(channel_type)='evolution'
  AND meta_connection_mode IS NOT NULL;

\echo '=== VALIDATE Meta ==='
SELECT count(*) AS meta_null_mode
FROM public.whatsapp_channels
WHERE deleted_at IS NULL AND lower(channel_type)='meta'
  AND meta_connection_mode IS NULL;

SELECT count(*) AS meta_cloud_api
FROM public.whatsapp_channels
WHERE deleted_at IS NULL AND lower(channel_type)='meta'
  AND meta_connection_mode='cloud_api';

SELECT count(*) AS coexistence_count
FROM public.whatsapp_channels
WHERE deleted_at IS NULL AND meta_connection_mode='coexistence';
SQL
echo "after_sql_exit=$?"

awk '/^=== CHANNEL SNAPSHOT ===/{p=1;next} /^===/{if(p){exit}} p' \
  "${BACKUP_DIR}/before_${STAMP}.txt" > "${BACKUP_DIR}/before_channels_${STAMP}.txt"
awk '/^=== CHANNEL SNAPSHOT ===/{p=1;next} /^===/{if(p){exit}} p' \
  "${BACKUP_DIR}/after_${STAMP}.txt" > "${BACKUP_DIR}/after_channels_${STAMP}.txt"

if diff -u "${BACKUP_DIR}/before_channels_${STAMP}.txt" "${BACKUP_DIR}/after_channels_${STAMP}.txt"; then
  echo "diff_channels=EMPTY_OK"
else
  echo "diff_channels=HAS_DIFF"
  exit 1
fi
```

Se `diff_channels=HAS_DIFF` → **PARE** (sem rollback automático).

---

## Proibido nesta janela

restart · smoke · número real · env · deploy · commit · rollback automático
