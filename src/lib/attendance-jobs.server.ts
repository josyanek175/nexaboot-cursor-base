import { ATTENDANCE_LIFECYCLE_SCHEMA } from "@/lib/attendance-lifecycle-schema";
import { getSql } from "@/lib/pg.server";
import { onAutomationInbound } from "@/lib/automation-flow.server";

let ready: Promise<void> | null = null;
export function ensureAttendanceLifecycleSchema(): Promise<void> {
  if (!ready)
    ready = (async () => {
      if (process.env.NODE_ENV === "production") {
        // Production migrations remain an explicit operational step.
        await getSql()`SELECT whatsapp_profile_name FROM public.contacts LIMIT 0`;
        await getSql()`SELECT sequence_id FROM public.attendance_automation_jobs LIMIT 0`;
      } else {
        await getSql().unsafe(ATTENDANCE_LIFECYCLE_SCHEMA);
      }
    })().catch((error) => {
      ready = null;
      throw error;
    });
  return ready;
}

type Job = {
  id: string;
  company_id: string;
  channel_id: string;
  conversation_id: string;
  contact_id: string;
  text: string;
  is_media: boolean;
  claim_token: string;
};

/** Claims in FIFO order per cycle. The transaction ends before Meta is called. */
export async function drainAttendanceJobs(conversationId?: string, limit = 20): Promise<number> {
  await ensureAttendanceLifecycleSchema();
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const rows = await getSql().begin(async (tx) => {
      // Short global claim lock; it never spans an external send.
      await tx`SELECT pg_advisory_xact_lock(7241093261::bigint)`;
      return tx<Job[]>`
        UPDATE public.attendance_automation_jobs j
        SET status = 'processing', lease_until = now() + interval '5 minutes',
            claim_token = gen_random_uuid(), attempts = attempts + 1
        WHERE j.id = (
          SELECT candidate.id FROM public.attendance_automation_jobs candidate
          WHERE candidate.status <> 'processed' AND candidate.available_at <= now()
            AND (candidate.status <> 'processing' OR candidate.lease_until < now())
            AND (${conversationId ?? null}::uuid IS NULL OR candidate.conversation_id = ${conversationId ?? null}::uuid)
            AND NOT EXISTS (
              SELECT 1 FROM public.attendance_automation_jobs earlier
              WHERE earlier.conversation_id = candidate.conversation_id AND earlier.status <> 'processed'
                AND earlier.sequence_id < candidate.sequence_id
            )
          ORDER BY candidate.sequence_id LIMIT 1 FOR UPDATE SKIP LOCKED
        ) RETURNING j.*
      `;
    });
    const job = rows[0];
    if (!job) break;
    const heartbeat = setInterval(() => {
      void getSql()`UPDATE public.attendance_automation_jobs SET lease_until = now() + interval '5 minutes'
        WHERE id = ${job.id}::uuid AND claim_token = ${job.claim_token}::uuid AND status = 'processing'`.catch(
        () => {},
      );
    }, 30000);
    heartbeat.unref();
    try {
      await onAutomationInbound({
        companyId: job.company_id,
        channelId: job.channel_id,
        conversationId: job.conversation_id,
        contactId: job.contact_id,
        text: job.text,
        isMedia: job.is_media,
        throwErrors: true,
      });
      await getSql()`UPDATE public.attendance_automation_jobs SET status = 'processed', lease_until = NULL,
        last_error = NULL WHERE id = ${job.id}::uuid AND claim_token = ${job.claim_token}::uuid`;
      processed++;
    } catch {
      await getSql()`UPDATE public.attendance_automation_jobs SET status = 'retry',
        lease_until = NULL, available_at = now() + interval '30 seconds', last_error = 'automation_processing_failed'
        WHERE id = ${job.id}::uuid AND claim_token = ${job.claim_token}::uuid`;
      break;
    } finally {
      clearInterval(heartbeat);
    }
  }
  return processed;
}

let pumpStarted = false;
/** One bounded pump per web process; SQL claims coordinate replicas. */
export function startAttendanceJobPump(): void {
  if (pumpStarted) return;
  pumpStarted = true;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainAttendanceJobs(undefined, 20);
    } catch {
      console.error(
        "[ATTENDANCE_JOB_PUMP_FAILED] Check lifecycle migration and database availability.",
      );
    } finally {
      running = false;
    }
  }, 15000);
  timer.unref();
}
