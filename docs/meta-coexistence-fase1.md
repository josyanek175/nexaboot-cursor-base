# Meta Coexistence — impacto e implantação

## Liberação controlada

| Condição | Efeito |
|---|---|
| `META_COEXISTENCE_ENABLED` ausente / `false` | Sem UI; endpoints → 404; Cloud API idêntica |
| `META_COEXISTENCE_ENABLED` = `true` | Gate ativo; ainda exige role + allowlist |
| role ≠ `SUPER_ADMIN` / `TI` | → 403 |
| `META_COEXISTENCE_ALLOWED_COMPANY_IDS` vazio | → 403 (ninguém), mesmo com flag true |
| company fora da allowlist | → 403 |

Gate backend: `assertMetaCoexistenceAccess` em start/complete/config/exchange/connect.

Env (somente variáveis de ambiente — nunca no código):

- `META_COEXISTENCE_ENABLED` (PROD inicial: `false`)
- `META_COEXISTENCE_ALLOWED_COMPANY_IDS` (UUIDs CSV; vazio = ninguém)
- `META_APP_ID`
- `META_EMBEDDED_SIGNUP_CONFIG_ID`
- `META_EMBEDDED_SIGNUP_REDIRECT_URI` (opcional)
- `META_APP_SECRET` / `META_TOKEN_ENCRYPTION_KEY` / `META_GRAPH_API_VERSION` (existentes)

## Fluxo onboarding (authorization code 1x)

1. `GET /config` → `csrf_state` (TTL 10 min, uso único)
2. Embedded Signup → `code` (só na Promise do browser; não localStorage/query)
3. `POST /exchange` `{ code, state, session_info? }` → troca code **uma vez**, resolve WABA/phone, cifra token, cria onboarding, devolve DTO seguro
4. `POST /connect` `{ onboarding_id }` → **sem code/token**; claim atômico; cria canal; scrub ciphertext

Preferido (Embedded Signup oficial): `POST /api/meta/embedded-signup/start` → complete.

## Migration

Ordem (DEV → PROD, com backup):

1. `docs/migrations/20260801_meta_connection_mode.sql`
2. `docs/migrations/20260801_meta_coexistence_onboarding.sql` (já inclui `resulting_channel_id`)
3. `docs/migrations/20260802_meta_coexistence_connected_at.sql`

Rollbacks espelhados `*_rollback.sql`.  
`20260801_meta_coexistence_onboarding_channel_id.sql` só se a tabela onboarding existir **sem** `resulting_channel_id`.

## Checklist produção (liberação controlada)

- [ ] Migrations em DEV primeiro (backup + rollback)
- [ ] Deploy DEV; validar Meta Cloud API + Evolution
- [ ] Mesmos commits DEV → `main` (sem edits diretos em main)
- [ ] Migrations PROD com backup + rollback
- [ ] Deploy PROD com `META_COEXISTENCE_ENABLED=false`
- [ ] Validar login, canais, Meta atuais, Evolution, webhook, send/recv
- [ ] Só então: allowlist da empresa de teste + flag true + SUPER_ADMIN/TI
- [ ] Não liberar para todos; não expor secrets em logs

## Endpoints (gated)

- `POST /api/meta/embedded-signup/start`
- `POST /api/meta/embedded-signup/complete`
- `GET /api/meta/channels/$id/connection-status`
- Legado (mesmo gate): `GET/POST /api/meta/coexistence/{config,exchange,connect}`

## Armazenamento temporário

PostgreSQL (`meta_coexistence_onboardings` + `meta_coexistence_csrf_states`) com `access_token_ciphertext` AES-GCM. Sem Redis no monorepo. Sem memória de processo.

## Não alterado

- `MetaTokenModal` (fluxo token permanente)
- Evolution
- Pipeline envio / templates / campanhas / janela 24h
- Lookup `phone_number_id`
- Webhook assinatura/dedupe; echo/history só log
