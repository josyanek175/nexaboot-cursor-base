#!/usr/bin/env bash
# =============================================================================
# Console EasyPanel: nexabootprincipal → nexaboot-evolution-db
# Database: nexabootprincipal · User: postgres
#
# Modos (obrigatório):
#   MODE=BACKUP  — identidade + dumps; encerra ANTES de qualquer migration
#   MODE=APPLY   — exige STAMP + BACKUP_DIR + dumps + arquivos .sql; aplica
#
# Exemplos:
#   MODE=BACKUP bash PROD_RUN_IN_EASYPANEL.sh
#   MODE=BACKUP STAMP=20260803T021500Z BACKUP_DIR=/tmp/nexaboot_coex_backup_20260803T021500Z \
#     bash PROD_RUN_IN_EASYPANEL.sh
#
#   # Baixe os dumps para fora do container, depois:
#   MODE=APPLY STAMP=... BACKUP_DIR=... MIG_DIR=/tmp \
#     bash PROD_RUN_IN_EASYPANEL.sh
#
# MIG_DIR = diretório com os três .sql (default: pasta deste script).
# NÃO inclui restart, env, smoke, rollback ou envio externo.
# =============================================================================

set -uo pipefail
# Não usamos `set -e`: cada etapa captura ec=$? e encerra explicitamente.

DB_NAME=nexabootprincipal
DB_USER=postgres
PSQL=(psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1)

MODE="${MODE:-${1:-}}"
if [ "$MODE" != "BACKUP" ] && [ "$MODE" != "APPLY" ]; then
  echo "ABORT: defina MODE=BACKUP ou MODE=APPLY"
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
MIG_DIR="${MIG_DIR:-$SCRIPT_DIR}"

MIG1_NAME="20260803_meta_connection_mode_nullable.sql"
MIG2_NAME="20260801_meta_coexistence_onboarding.sql"
MIG3_NAME="20260802_meta_coexistence_connected_at.sql"

confirm_identity() {
  local ec db_check user_check
  echo "========== identidade =========="
  "${PSQL[@]}" -c \
    "SELECT current_database() AS db, current_user AS usr, inet_server_addr() AS addr, inet_server_port() AS port, now() AS ts;"
  ec=$?
  if [ "$ec" -ne 0 ]; then
    echo "identity_psql_exit=$ec"
    exit "$ec"
  fi

  db_check="$("${PSQL[@]}" -Atc "SELECT current_database();")"
  ec=$?
  if [ "$ec" -ne 0 ]; then
    echo "identity_db_exit=$ec"
    exit "$ec"
  fi

  user_check="$("${PSQL[@]}" -Atc "SELECT current_user();")"
  ec=$?
  if [ "$ec" -ne 0 ]; then
    echo "identity_user_exit=$ec"
    exit "$ec"
  fi

  if [ "$db_check" != "nexabootprincipal" ]; then
    echo "ABORT: current_database='$db_check' (esperado nexabootprincipal)"
    exit 1
  fi
  if [ "$user_check" != "postgres" ]; then
    echo "ABORT: current_user='$user_check' (esperado postgres)"
    exit 1
  fi
  echo "identity_ok=1 db=$db_check user=$user_check"
}

require_file_nonempty() {
  local path="$1"
  local label="$2"
  if [ ! -e "$path" ]; then
    echo "ABORT: $label ausente: $path"
    exit 1
  fi
  if [ ! -s "$path" ]; then
    echo "ABORT: $label vazio: $path"
    exit 1
  fi
  ls -lh "$path"
}

dump_paths() {
  FULL_DUMP="${BACKUP_DIR}/nexabootprincipal_pre_coex_${STAMP}.dump"
  CHANNELS_DUMP="${BACKUP_DIR}/whatsapp_channels_pre_coex_${STAMP}.dump"
}

# ─── BACKUP ──────────────────────────────────────────────────────────────────
mode_backup() {
  local ec
  echo "========== MODE=BACKUP =========="
  hostname
  command -v psql
  command -v pg_dump
  psql --version
  pg_dump --version

  confirm_identity

  if [ -z "${STAMP:-}" ]; then
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    echo "STAMP_generated=$STAMP"
  else
    echo "STAMP_reused=$STAMP"
  fi

  if [ -z "${BACKUP_DIR:-}" ]; then
    BACKUP_DIR="/tmp/nexaboot_coex_backup_${STAMP}"
    echo "BACKUP_DIR_generated=$BACKUP_DIR"
  else
    echo "BACKUP_DIR_reused=$BACKUP_DIR"
  fi

  mkdir -p "$BACKUP_DIR"
  dump_paths

  echo "========== pg_dump full =========="
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f "$FULL_DUMP"
  ec=$?
  echo "pg_dump_full_exit=$ec"
  if [ "$ec" -ne 0 ]; then
    exit "$ec"
  fi
  require_file_nonempty "$FULL_DUMP" "dump completo"

  echo "========== pg_dump whatsapp_channels =========="
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -t public.whatsapp_channels -f "$CHANNELS_DUMP"
  ec=$?
  echo "pg_dump_channels_exit=$ec"
  if [ "$ec" -ne 0 ]; then
    exit "$ec"
  fi
  require_file_nonempty "$CHANNELS_DUMP" "dump whatsapp_channels"

  echo ""
  echo "STAMP=$STAMP"
  echo "BACKUP_DIR=$BACKUP_DIR"
  echo "FULL_DUMP=$FULL_DUMP"
  echo "CHANNELS_DUMP=$CHANNELS_DUMP"
  echo ""
  echo "BACKUP_DONE=1"
  echo ">>> Baixe os dois .dump para fora do container ANTES do MODE=APPLY."
  echo ">>> Exemplo APPLY:"
  echo ">>>   MODE=APPLY STAMP=$STAMP BACKUP_DIR=$BACKUP_DIR MIG_DIR=/caminho/com/sqls \\"
  echo ">>>     bash $0"
  echo ">>> Encerrando sem migrations (obrigatório)."
  exit 0
}

# ─── APPLY ───────────────────────────────────────────────────────────────────
mode_apply() {
  local ec before_snap after_snap
  echo "========== MODE=APPLY =========="
  hostname
  command -v psql
  psql --version

  if [ -z "${STAMP:-}" ]; then
    echo "ABORT: MODE=APPLY exige STAMP já definido (não gera timestamp novo)"
    exit 1
  fi
  if [ -z "${BACKUP_DIR:-}" ]; then
    echo "ABORT: MODE=APPLY exige BACKUP_DIR já definido (não cria novo diretório)"
    exit 1
  fi
  if [ ! -d "$BACKUP_DIR" ]; then
    echo "ABORT: BACKUP_DIR não é um diretório existente: $BACKUP_DIR"
    exit 1
  fi

  echo "STAMP=$STAMP"
  echo "BACKUP_DIR=$BACKUP_DIR"
  dump_paths

  echo "========== validar dumps existentes =========="
  require_file_nonempty "$FULL_DUMP" "dump completo"
  require_file_nonempty "$CHANNELS_DUMP" "dump whatsapp_channels"

  echo "========== localizar migrations (MIG_DIR=$MIG_DIR) =========="
  MIG1_PATH="${MIG_DIR}/${MIG1_NAME}"
  MIG2_PATH="${MIG_DIR}/${MIG2_NAME}"
  MIG3_PATH="${MIG_DIR}/${MIG3_NAME}"

  require_file_nonempty "$MIG1_PATH" "migration 1"
  require_file_nonempty "$MIG2_PATH" "migration 2"
  require_file_nonempty "$MIG3_PATH" "migration 3"
  echo "mig1_path=$MIG1_PATH"
  echo "mig2_path=$MIG2_PATH"
  echo "mig3_path=$MIG3_PATH"

  confirm_identity

  BEFORE_FILE="${BACKUP_DIR}/before_${STAMP}.txt"
  AFTER_FILE="${BACKUP_DIR}/after_${STAMP}.txt"

  echo "========== snapshot Antes =========="
  "${PSQL[@]}" -o "$BEFORE_FILE" <<'SQL'
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
  ec=$?
  echo "before_sql_exit=$ec"
  if [ "$ec" -ne 0 ]; then
    exit "$ec"
  fi
  require_file_nonempty "$BEFORE_FILE" "snapshot Antes"

  echo "========== mig1: $MIG1_NAME =========="
  "${PSQL[@]}" -f "$MIG1_PATH"
  ec=$?
  echo "mig1_exit=$ec"
  if [ "$ec" -ne 0 ]; then
    exit "$ec"
  fi

  echo "========== mig2: $MIG2_NAME =========="
  "${PSQL[@]}" -f "$MIG2_PATH"
  ec=$?
  echo "mig2_exit=$ec"
  if [ "$ec" -ne 0 ]; then
    exit "$ec"
  fi

  echo "========== mig3: $MIG3_NAME =========="
  "${PSQL[@]}" -f "$MIG3_PATH"
  ec=$?
  echo "mig3_exit=$ec"
  if [ "$ec" -ne 0 ]; then
    exit "$ec"
  fi

  echo "========== snapshot Depois + validações =========="
  "${PSQL[@]}" -o "$AFTER_FILE" <<'SQL'
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

\echo '=== VALIDATE unexpected coexistence ==='
SELECT count(*) AS coexistence_count
FROM public.whatsapp_channels
WHERE deleted_at IS NULL
  AND meta_connection_mode = 'coexistence';

\echo '=== VALIDATE Meta null mode (should be 0) ==='
SELECT count(*) AS meta_null_mode
FROM public.whatsapp_channels
WHERE deleted_at IS NULL
  AND lower(channel_type) = 'meta'
  AND meta_connection_mode IS NULL;

\echo '=== VALIDATE Meta cloud_api count ==='
SELECT count(*) AS meta_cloud_api
FROM public.whatsapp_channels
WHERE deleted_at IS NULL
  AND lower(channel_type) = 'meta'
  AND meta_connection_mode = 'cloud_api';
SQL
  ec=$?
  echo "after_sql_exit=$ec"
  if [ "$ec" -ne 0 ]; then
    exit "$ec"
  fi
  require_file_nonempty "$AFTER_FILE" "snapshot Depois"

  before_snap="${BACKUP_DIR}/before_channels_${STAMP}.txt"
  after_snap="${BACKUP_DIR}/after_channels_${STAMP}.txt"
  awk '/^=== CHANNEL SNAPSHOT ===/{p=1;next} /^===/{if(p){exit}} p' "$BEFORE_FILE" > "$before_snap"
  awk '/^=== CHANNEL SNAPSHOT ===/{p=1;next} /^===/{if(p){exit}} p' "$AFTER_FILE" > "$after_snap"

  echo "========== DIFF CHANNEL SNAPSHOT =========="
  if diff -u "$before_snap" "$after_snap"; then
    echo "diff_channels=EMPTY_OK"
  else
    echo "diff_channels=HAS_DIFF"
    exit 1
  fi

  echo "========== APPLY_DONE =========="
  echo "STAMP=$STAMP"
  echo "BACKUP_DIR=$BACKUP_DIR"
  echo "Antes: $BEFORE_FILE"
  echo "Depois: $AFTER_FILE"
  echo "Sem restart / smoke / alteração de env."
  exit 0
}

case "$MODE" in
  BACKUP) mode_backup ;;
  APPLY) mode_apply ;;
  *)
    echo "ABORT: MODE inválido"
    exit 2
    ;;
esac
