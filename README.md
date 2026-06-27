# NexaBoot Meta

Plataforma SaaS multiempresa de multiatendimento via **Meta WhatsApp Cloud API**.

## Stack

- React 19 + TypeScript
- Vite 7 + TanStack Start (SSR / server functions)
- Tailwind CSS v4
- Lovable Cloud (Supabase: Postgres, Auth, Storage)

## Estrutura

```
src/
  features/
    tenants/         # Empresas (multitenant)
    conversations/   # Conversas e mensagens
    attendance/      # Multiatendimento (filas/atribuição)
    dashboard/       # Painel administrativo
  integrations/
    supabase/        # Clientes auto-gerados (NÃO editar)
    meta-whatsapp/   # Integração Meta WhatsApp Cloud API
  routes/            # Rotas TanStack (file-based)
```

## Próximos passos

1. Importar/portar código existente do NexaBoot a partir do GitHub.
2. Modelar tabelas multitenant no Supabase (com RLS por `tenant_id`).
3. Configurar autenticação (email/senha + Google).
4. Implementar webhook da Meta WhatsApp em `src/routes/api/public/whatsapp/webhook.ts`.
5. Construir dashboard administrativo e inbox de conversas.
