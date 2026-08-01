# Meta Coexistence — impacto e implantação (DEV only)

Documento de entrega. **Não aplicar migration, não commit, não deploy** sem aprovação.

## Feature flag

| Variável | Valores | Efeito |
|---|---|---|
| `META_COEXISTENCE_ENABLED` | ausente / `false` | Sem UI Coexistence; endpoints `/api/meta/coexistence/*` → 404; Meta Cloud API idêntica; tabelas temporárias **não são acessadas** |
| `META_COEXISTENCE_ENABLED` | `true` / `1` / `yes` | UI + endpoints Coexistence (admins); Cloud API tradicional permanece |

Env auxiliares (somente DEV, quando flag true):

- `META_APP_ID`
- `META_EMBEDDED_SIGNUP_CONFIG_ID`
- `META_EMBEDDED_SIGNUP_REDIRECT_URI` (opcional)
- `META_APP_SECRET` (já usado no webhook)
- `META_GRAPH_API_VERSION` (default `v21.0`)
- `META_TOKEN_ENCRYPTION_KEY` (obrigatória — onboarding cifra o token)

## Fluxo onboarding (authorization code 1x)

1. `GET /config` → `csrf_state` (TTL 10 min, uso único)
2. Embedded Signup → `code` (só na Promise do browser; não localStorage/query)
3. `POST /exchange` `{ code, state, session_info? }` → troca code **uma vez**, resolve WABA/phone, cifra token, cria onboarding, devolve DTO seguro
4. `POST /connect` `{ onboarding_id }` → **sem code/token**; claim atômico; cria canal; scrub ciphertext

## Migration

- Canais: `docs/migrations/20260801_meta_connection_mode.sql`
- Onboarding temp: `docs/migrations/20260801_meta_coexistence_onboarding.sql`
- Rollbacks em `docs/migrations/*_rollback.sql`
- **Não aplicadas.**

## Endpoints (gated)

- `GET /api/meta/coexistence/config`
- `POST /api/meta/coexistence/exchange`
- `POST /api/meta/coexistence/connect`

## Armazenamento temporário

PostgreSQL (`meta_coexistence_onboardings` + `meta_coexistence_csrf_states`) com `access_token_ciphertext` AES-GCM. Sem Redis no monorepo. Sem memória de processo.

## Não alterado

- `MetaTokenModal` (fluxo token permanente)
- Evolution
- Pipeline envio / templates / campanhas / janela 24h
- Lookup `phone_number_id`
- Webhook assinatura/dedupe; echo/history só log

## Checklist produção

- [ ] Não setar `META_COEXISTENCE_ENABLED` em produção
- [ ] Não aplicar migration em produção
- [ ] Não alterar EasyPanel prod
- [ ] Não merge/push para `main` sem aprovação
- [ ] Validar em DEV: flag false ⇒ 404 e sem uso de tabelas temp
