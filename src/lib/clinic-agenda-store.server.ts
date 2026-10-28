import { appointmentSchema, professionalSchema, minutes } from "./clinic-agenda";
import type { getSql } from "./pg.server";

export class AgendaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
// Parameterized repository also used by isolated database tests. Never creates schema at runtime.
export function agendaStore(db: ReturnType<typeof getSql>) {
  async function list(companyId: string, from: string, to: string) {
    const professionals =
      await db`SELECT id,name,specialty,duration,to_char(opens,'HH24:MI') AS opens,
      to_char(closes,'HH24:MI') AS closes,weekdays FROM public.clinic_professionals WHERE company_id=${companyId}::uuid ORDER BY name,id`;
    const appointments =
      await db`SELECT a.id,a.professional_id AS "professionalId",a.contact_id AS "contactId",
      to_char(a.starts_at,'YYYY-MM-DD') AS date,to_char(a.starts_at,'HH24:MI') AS time,
      a.duration,a.kind,a.patient,a.phone,a.service,a.status,a.reminder_hours AS "reminderHours",
      a.version,a.reminder_copied_at AS "reminderCopiedAt",p.name AS "professionalName"
      FROM public.clinic_appointments a JOIN public.clinic_professionals p ON p.id=a.professional_id AND p.company_id=a.company_id
      WHERE a.company_id=${companyId}::uuid AND a.starts_at>=${from}::date AND a.starts_at<${to}::date+interval '1 day'
      ORDER BY a.starts_at,p.name,a.id LIMIT 2001`;
    if (appointments.length > 2000)
      throw new AgendaError(422, "Há muitos registros. Consulte um período menor.");
    return { professionals, appointments };
  }
  async function createProfessional(companyId: string, input: unknown) {
    const p = professionalSchema.parse(input);
    const [row] =
      await db`INSERT INTO public.clinic_professionals(company_id,name,specialty,duration,opens,closes,weekdays)
      VALUES(${companyId}::uuid,${p.name},${p.specialty},${p.duration},${p.opens}::time,${p.closes}::time,${JSON.stringify(p.weekdays)}::jsonb) RETURNING id`;
    return row;
  }
  async function save(companyId: string, userId: string, input: unknown) {
    const a = appointmentSchema.parse(input);
    return db.begin(async (tx) => {
      // Serialize all agenda writes in this tenant across instances. The SELECT after the lock
      // uses READ COMMITTED, so it sees the transaction which just released the lock.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${companyId}, 61028))`;
      const [old] =
        await tx`SELECT * FROM public.clinic_appointments WHERE id=${a.id}::uuid AND company_id=${companyId}::uuid FOR UPDATE`;
      if (old && a.version === undefined) {
        // A retried create must never overwrite a later edit.
        const [same] =
          await tx`SELECT id FROM public.clinic_appointments WHERE id=${a.id}::uuid AND company_id=${companyId}::uuid
          AND professional_id=${a.professionalId}::uuid AND contact_id IS NOT DISTINCT FROM ${a.contactId}::uuid
          AND starts_at=${a.date + " " + a.time}::timestamp AND duration=${a.duration} AND kind=${a.kind}
          AND patient=${a.patient} AND phone=${a.phone} AND service=${a.service} AND status=${a.status} AND reminder_hours=${a.reminderHours}`;
        if (!same)
          throw new AgendaError(
            409,
            "Este agendamento já foi salvo com outros dados. Atualize a agenda antes de editar.",
          );
        return { id: a.id, duplicate: true };
      }
      if ((!old && a.version !== undefined) || (old && old.version !== a.version))
        throw new AgendaError(409, "O agendamento mudou. Atualize a agenda e tente novamente.");
      const [p] =
        await tx`SELECT id,to_char(opens,'HH24:MI') AS opens,to_char(closes,'HH24:MI') AS closes,weekdays
        FROM public.clinic_professionals WHERE id=${a.professionalId}::uuid AND company_id=${companyId}::uuid`;
      if (!p) throw new AgendaError(404, "Profissional não encontrado nesta empresa.");
      if (a.contactId) {
        const [contact] =
          await tx`SELECT id FROM public.contacts WHERE id=${a.contactId}::uuid AND company_id=${companyId}::uuid`;
        if (!contact) throw new AgendaError(404, "Contato não encontrado nesta empresa.");
      }
      if (a.status !== "cancelled") {
        if (
          !p.weekdays.includes(new Date(`${a.date}T12:00:00Z`).getUTCDay()) ||
          minutes(a.time) < minutes(p.opens) ||
          minutes(a.time) + a.duration > minutes(p.closes)
        )
          throw new AgendaError(422, "Horário fora do expediente deste profissional.");
        const conflict =
          await tx`SELECT id FROM public.clinic_appointments WHERE company_id=${companyId}::uuid
          AND professional_id=${a.professionalId}::uuid AND id<>${a.id}::uuid AND status<>'cancelled'
          AND starts_at<${a.date + " " + a.time}::timestamp+make_interval(mins=>${a.duration})
          AND starts_at+make_interval(mins=>duration)>${a.date + " " + a.time}::timestamp LIMIT 1`;
        if (conflict.length)
          throw new AgendaError(409, "Este horário já está ocupado. Escolha outro horário.");
      }
      if (old) {
        await tx`UPDATE public.clinic_appointments SET professional_id=${a.professionalId}::uuid,contact_id=${a.contactId}::uuid,
          starts_at=${a.date + " " + a.time}::timestamp,duration=${a.duration},kind=${a.kind},patient=${a.patient},phone=${a.phone},service=${a.service},
          status=${a.status},reminder_hours=${a.reminderHours},reminder_copied_at=NULL,version=version+1,updated_at=now()
          WHERE id=${a.id}::uuid AND company_id=${companyId}::uuid`;
      } else {
        await tx`INSERT INTO public.clinic_appointments(id,company_id,professional_id,contact_id,starts_at,duration,kind,patient,phone,service,status,reminder_hours,created_by)
          VALUES(${a.id}::uuid,${companyId}::uuid,${a.professionalId}::uuid,${a.contactId}::uuid,${a.date + " " + a.time}::timestamp,
          ${a.duration},${a.kind},${a.patient},${a.phone},${a.service},${a.status},${a.reminderHours},${userId}::uuid)`;
      }
      return { id: a.id };
    });
  }
  return { list, createProfessional, save };
}
