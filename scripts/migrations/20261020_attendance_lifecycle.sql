-- Explicit migration; refuses duplicate active conversations instead of merging history.
-- First inspect: SELECT company_id,whatsapp_channel_id,contact_id,count(*) FROM public.conversations
-- WHERE status IN ('open','waiting') AND contact_id IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1;
BEGIN;
-- Replace the old proposed index if it was manually installed: it also covered finished cycles.
DROP INDEX IF EXISTS public.conversations_company_channel_contact_active_uniq;

      ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS whatsapp_profile_name text;
      ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS message_source text;
      CREATE TABLE IF NOT EXISTS public.attendance_automation_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sequence_id bigserial UNIQUE,
        company_id uuid NOT NULL, channel_id uuid NOT NULL,
        conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE RESTRICT,
        contact_id uuid NOT NULL, message_id uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE RESTRICT,
        text text NOT NULL, is_media boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
        available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
        claim_token uuid, last_error text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_company_channel_contact_open_uniq
        ON public.conversations (company_id, whatsapp_channel_id, contact_id)
        WHERE contact_id IS NOT NULL AND status IN ('open', 'waiting');
      CREATE INDEX IF NOT EXISTS attendance_jobs_pending_idx
        ON public.attendance_automation_jobs (conversation_id, sequence_id) WHERE status <> 'processed';

UPDATE public.contacts SET whatsapp_profile_name = name
WHERE whatsapp_profile_name IS NULL AND name_source = 'whatsapp' AND nullif(btrim(name), '') IS NOT NULL;
COMMIT;
