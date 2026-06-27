# Meta WhatsApp Cloud API

Pasta reservada para a integração com a Meta WhatsApp Cloud API.

Convenções:
- Funções server-side ficam em `*.functions.ts` usando `createServerFn`
- Webhook da Meta deve viver em `src/routes/api/public/whatsapp/webhook.ts`
- Secrets necessárias (a configurar quando for integrar):
  - `META_WHATSAPP_TOKEN`
  - `META_WHATSAPP_PHONE_NUMBER_ID`
  - `META_WHATSAPP_VERIFY_TOKEN`
  - `META_WHATSAPP_APP_SECRET`
