import { z } from "zod";

export const AGENDA_ROLES = ["SUPER_ADMIN", "TI", "ADMIN_GERAL", "ADMIN_EMPRESA"];
export const AGENDA_ZONE = "America/Sao_Paulo";
export const statuses = {
  scheduled: "Agendada",
  confirmed: "Confirmada",
  arrived: "Paciente chegou",
  completed: "Concluída",
  absent: "Não compareceu",
  cancelled: "Cancelada",
} as const;
export type AgendaStatus = keyof typeof statuses;
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Data inválida");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const professionalSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    specialty: z.string().trim().max(80).default(""),
    duration: z.number().int().min(5).max(180).default(30),
    opens: time.default("08:00"),
    closes: time.default("18:00"),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  })
  .refine((p) => p.opens < p.closes, "O fim do expediente deve ser após o início");
export const appointmentSchema = z
  .object({
    id: z.string().uuid(),
    professionalId: z.string().uuid(),
    date: dateSchema,
    time,
    duration: z.number().int().min(5).max(180),
    kind: z.enum(["appointment", "block"]).default("appointment"),
    patient: z.string().trim().max(120).default(""),
    phone: z.string().trim().max(25).default(""),
    contactId: z.string().uuid().nullable().default(null),
    service: z.string().trim().min(2).max(100),
    status: z
      .enum(["scheduled", "confirmed", "arrived", "completed", "absent", "cancelled"])
      .default("scheduled"),
    reminderHours: z.union([z.literal(0), z.literal(2), z.literal(24), z.literal(48)]).default(24),
    version: z.number().int().min(1).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.kind === "appointment" && a.patient.length < 2)
      ctx.addIssue({ code: "custom", message: "Informe o nome do paciente", path: ["patient"] });
    if (a.phone && !/^\+?[\d\s()-]{8,25}$/.test(a.phone))
      ctx.addIssue({ code: "custom", message: "Telefone inválido", path: ["phone"] });
    if (minutes(a.time) + a.duration > 1440)
      ctx.addIssue({
        code: "custom",
        message: "O horário deve terminar no mesmo dia",
        path: ["duration"],
      });
  });
export type ProfessionalInput = z.infer<typeof professionalSchema>;
export type AppointmentInput = z.infer<typeof appointmentSchema>;
export type Professional = ProfessionalInput & { id: string };
export type Appointment = AppointmentInput & {
  version: number;
  professionalName: string;
  reminderCopiedAt: string | null;
};
export function minutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
export function endTime(t: string, duration: number) {
  const m = minutes(t) + duration;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
export function agendaToday(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: AGENDA_ZONE }).format(now);
}
export function moveDate(date: string, delta: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
export function occupies(status: string) {
  return status !== "cancelled";
}
export function availableSlots(
  p: Professional,
  date: string,
  items: Appointment[],
  duration = p.duration,
) {
  if (!p.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return [];
  const slots: string[] = [];
  for (let m = minutes(p.opens); m + duration <= minutes(p.closes); m += 5) {
    if (
      !items.some(
        (a) =>
          a.professionalId === p.id &&
          a.date === date &&
          occupies(a.status) &&
          m < minutes(a.time) + a.duration &&
          m + duration > minutes(a.time),
      )
    ) {
      slots.push(
        `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
      );
    }
  }
  return slots;
}
export function reminderText(a: Appointment, companyName: string) {
  const date = a.date.split("-").reverse().join("/");
  return `Olá, ${a.patient}! Aqui é da ${companyName || "clínica"}. Lembramos do seu agendamento em ${date}, às ${a.time}. Você pode confirmar sua presença? Se precisar remarcar, fale conosco por aqui.`;
}
