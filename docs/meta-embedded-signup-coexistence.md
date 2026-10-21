# Meta Embedded Signup / Coexistence — lacunas de configuração

Valores **não inventados**. Preencher a partir do painel Meta / EasyPanel DEV.

## Liberação controlada

| Condição | Efeito |
|---|---|
| `META_COEXISTENCE_ENABLED` ≠ true | endpoints → 404 |
| role ≠ `SUPER_ADMIN` / `TI` / `ADMIN_EMPRESA` | → 403 |
| `META_COEXISTENCE_ALLOWED_COMPANY_IDS` vazio/ausente | → 403 (ninguém) |
| company_id fora da allowlist | → 403 |
| company_id no request diferente da sessão | → 403 |

Gate no backend: `assertMetaCoexistenceAccessWithScope` (start/complete/config/exchange/connect/connection-status).
ADMIN_EMPRESA: company_id somente da sessão.

## Lacunas (env / painel Meta)

| Item | No código | Valor no repositório | Ação necessária |
|---|---|---|---|
| App ID | `META_APP_ID` | **ausente** (só `process.env`) | Copiar do Meta App Dashboard |
| Embedded Signup Config ID | `META_EMBEDDED_SIGNUP_CONFIG_ID` | **ausente** | Criar configuração Embedded Signup (WhatsApp) e copiar Config ID |
| App Secret | `META_APP_SECRET` | **ausente no repo** (já usado no webhook) | Confirmar o mesmo secret do app no EasyPanel DEV |
| Verify Token | `META_APP_VERIFY_TOKEN` | **ausente no repo** | Já usado no GET webhook; manter |
| Token encryption | `META_TOKEN_ENCRYPTION_KEY` | **ausente no repo** | Já usado no vault Cloud API |
| Feature flag | `META_COEXISTENCE_ENABLED` | default off | `true` só em DEV após migration |
| Redirect URI | `META_EMBEDDED_SIGNUP_REDIRECT_URI` | opcional | Se a Meta exigir, alinhar ao domínio DEV |
| Domínio autorizado | — | **não há env no código** | Em App Domains / Allowed Domains do app Meta, autorizar o domínio HTTPS do NexaBoot DEV |
| Webhook callback | `/api/webhooks/meta/whatsapp` | rota existente | Confirmar URL completa no painel Meta (DEV) |
| Graph version | `META_GRAPH_API_VERSION` | default código `v21.0` (coexistence) | Alinhar com versão do Embedded Signup |

## Permissões / produtos Meta (pendentes de confirmação no painel)

Sem acesso ao app Meta deste ambiente. Validar manualmente:

- Produto **WhatsApp** ativo
- **Embedded Signup** com `featureType` de onboarding do WhatsApp Business App (coexistence)
- Permissões típicas: `whatsapp_business_management`, `whatsapp_business_messaging`, `business_management` (conforme o fluxo oficial atual da Meta)
- Webhook fields: `messages` (mínimo); `smb_message_echoes` / history só após fixture real
- Inscrição do app na WABA: feita em runtime via `POST /{waba-id}/subscribed_apps` no `/complete`

## Migrations (ordem DEV)

1. `20260801_meta_connection_mode.sql` — `meta_connection_mode` (+ colunas coexistence)
2. `20260801_meta_coexistence_onboarding.sql` — CSRF + onboarding (já inclui `resulting_channel_id`)
3. `20260802_meta_coexistence_connected_at.sql` — `connected_at`, `webhook_subscribed_at`
4. **Não** executar `…_onboarding_channel_id.sql` se o passo 2 já foi aplicado (coluna já incluída)

## API

- `POST /api/meta/embedded-signup/start`
- `POST /api/meta/embedded-signup/complete`
- `GET /api/meta/channels/:id/connection-status`
- Legado (ainda gated): `/api/meta/coexistence/*`

## Echo / history

Não processamos `smb_message_echoes` / history sync além de log seguro até existir fixture oficial de DEV.
