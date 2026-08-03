-- Rollback connected_at / webhook_subscribed_at (somente DEV).

BEGIN;

ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS connected_at;
ALTER TABLE public.whatsapp_channels DROP COLUMN IF EXISTS webhook_subscribed_at;

COMMIT;
