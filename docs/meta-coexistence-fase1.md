# Meta Coexistence — impacto e implantação

## Liberação controlada

| Condição | Efeito |
|---|---|
| `META_COEXISTENCE_ENABLED` ausente / `false` | Sem UI; endpoints → 404; Cloud API idêntica |
| `META_COEXISTENCE_ENABLED` = `true` | Gate ativo; ainda exige role + allowlist |
| role ≠ `SUPER_ADMIN` / `TI` / `ADMIN_EMPRESA` | → 403 |
| `META_COEXISTENCE_ALLOWED_COMPANY_IDS` vazio | → 403 (ninguém), mesmo com flag true |
| company fora da allowlist | → 403 |
| `company_id` no request ≠ empresa da sessão | → 403 (`forbidden_company_scope`) |

Gate backend: `assertMetaCoexistenceAccessWithScope` em start/complete/config/exchange/connect/connection-status.

`ADMIN_EMPRESA` usa exclusivamente o `company_id` da sessão (sem seletor / sem body arbitrário).
`SUPER_ADMIN`/`TI` usam a empresa do seletor operacional (cookie), já validada como ativa.

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

Ordem **produção** (Console EasyPanel / `nexabootprincipal`):

1. `docs/migrations/20260803_meta_connection_mode_nullable.sql`  
   (**não** aplicar `20260801_meta_connection_mode.sql` em PROD — NOT NULL DEFAULT poluía Evolution)
2. `docs/migrations/20260801_meta_coexistence_onboarding.sql` (já inclui `resulting_channel_id`)
3. `docs/migrations/20260802_meta_coexistence_connected_at.sql`

Procedimento completo (backup, Antes/Depois, validações):  
`docs/migrations/PROD_APPLY_META_COEXISTENCE.md`

Arquivo histórico `20260801_meta_connection_mode.sql` permanece no repo para referência; não usar em PROD.

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
