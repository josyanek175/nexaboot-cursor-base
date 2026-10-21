-- Additive recovery for missing whatsapp_profile_name / automation queue.
-- Run ONLY against the same database used by nexaboot-web (DATABASE_URL).
-- Does not merge conversations or create a global active-conversation unique index.
-- If a previous command left the SQL session aborted, issue ROLLBACK separately first.
BEGIN;
SET LOCAL lock_timeout = '5s';

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
      CREATE INDEX IF NOT EXISTS attendance_jobs_pending_idx
        ON public.attendance_automation_jobs (conversation_id, sequence_id) WHERE status <> 'processed';

UPDATE public.contacts SET whatsapp_profile_name = name
WHERE whatsapp_profile_name IS NULL AND name_source = 'whatsapp' AND nullif(btrim(name), '') IS NOT NULL;
COMMIT;
-- Verification: expect the column and queue to be present.
SELECT current_database() AS database_name,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
         AND table_name = 'contacts' AND column_name = 'whatsapp_profile_name') AS profile_ready,
       to_regclass('public.attendance_automation_jobs') AS queue_table;
