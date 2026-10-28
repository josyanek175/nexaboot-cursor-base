import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isolatedPostgres, tsLoader } from "./test-support/isolated-postgres.mjs";
const { pg, db } = await isolatedPostgres();
const load = tsLoader();
const domain = load("src/lib/clinic-agenda.ts");
const { agendaStore } = load("src/lib/clinic-agenda-store.server.ts");
try {
  await pg.exec(readFileSync("scripts/migrations/20261028_clinic_agenda.sql", "utf8"));
  await pg.exec(readFileSync("scripts/migrations/20261028_clinic_agenda.sql", "utf8"));
  const [{ id: a }] = await db`INSERT INTO companies(name) VALUES('Clínica A') RETURNING id`;
  const [{ id: b }] = await db`INSERT INTO companies(name) VALUES('Clínica B') RETURNING id`;
  const user = randomUUID();
  const store = agendaStore(db);
  const p = await store.createProfessional(a, {
    name: "Profissional A",
    specialty: "Geral",
    duration: 30,
    opens: "08:00",
    closes: "18:00",
    weekdays: [1, 2, 3, 4, 5],
  });
  const q = await store.createProfessional(b, { name: "Profissional B", duration: 30 });
  const base = {
    id: randomUUID(),
    professionalId: p.id,
    date: "2026-10-28",
    time: "09:00",
    duration: 30,
    kind: "appointment",
    patient: "Paciente fictício",
    phone: "",
    contactId: null,
    service: "Consulta",
    status: "scheduled",
    reminderHours: 24,
  };
  await store.save(a, user, base);
  assert.equal((await store.list(a, base.date, base.date)).appointments.length, 1);
  assert.equal((await store.list(b, base.date, base.date)).appointments.length, 0);
  assert.equal((await store.list(b, base.date, base.date)).professionals.length, 1);
  await assert.rejects(
    store.save(b, user, { ...base, id: randomUUID() }),
    /Profissional não encontrado/,
  );
  await assert.rejects(
    store.save(a, user, { ...base, id: randomUUID(), professionalId: q.id }),
    /Profissional não encontrado/,
  );
  const [{ id: foreignContact }] =
    await db`INSERT INTO contacts(company_id,name) VALUES(${b}::uuid,'Outro paciente') RETURNING id`;
  await assert.rejects(
    store.save(a, user, { ...base, id: randomUUID(), contactId: foreignContact }),
    /Contato não encontrado/,
  );
  await assert.rejects(
    store.save(a, user, { ...base, id: randomUUID(), time: "09:15" }),
    /ocupado/,
  );
  await store.save(a, user, { ...base, id: randomUUID(), time: "09:30" });
  assert.equal((await store.save(a, user, base)).duplicate, true);
  await assert.rejects(store.save(a, user, { ...base, patient: "Outro nome" }), /outros dados/);
  assert.equal((await store.list(a, base.date, base.date)).appointments.length, 2);
  await assert.rejects(store.save(a, user, { ...base, version: 9 }), /mudou/);
  await store.save(a, user, { ...base, version: 1, status: "cancelled" });
  await store.save(a, user, { ...base, id: randomUUID(), time: "09:00" });
  await assert.rejects(store.save(a, user, { ...base, version: 1 }), /mudou/);
  await assert.rejects(
    store.save(a, user, { ...base, id: randomUUID(), date: "2026-11-01" }),
    /expediente/,
  );
  await assert.rejects(
    store.save(a, user, { ...base, id: randomUUID(), time: "17:45" }),
    /expediente/,
  );
  const block = {
    ...base,
    id: randomUUID(),
    kind: "block",
    patient: "",
    time: "12:00",
    duration: 60,
    service: "Intervalo",
  };
  await store.save(a, user, block);
  await assert.rejects(
    store.save(a, user, { ...base, id: randomUUID(), time: "12:30" }),
    /ocupado/,
  );
  const list = await store.list(a, base.date, base.date);
  const slots = domain.availableSlots(
    { ...list.professionals[0] },
    base.date,
    list.appointments,
    30,
  );
  assert(!slots.includes("09:00"));
  assert(!slots.includes("12:30"));
  assert(slots.includes("10:00"));
  assert.equal(domain.agendaToday(new Date("2026-10-29T01:00:00Z")), "2026-10-28");
  assert(!domain.dateSchema.safeParse("2026-02-30").success);
  assert(!domain.appointmentSchema.safeParse({ ...base, time: "23:30", duration: 60 }).success);
  assert(!domain.appointmentSchema.safeParse({ ...base, patient: "" }).success);
  assert(
    !domain.professionalSchema.safeParse({ name: "Profissional", opens: "18:00", closes: "08:00" })
      .success,
  );
  assert(
    domain.reminderText({ ...base, professionalName: "Equipe" }, "Clínica").includes("28/10/2026"),
  );
  const outcomes = await Promise.allSettled(
    [0, 1].map(() => store.save(a, user, { ...base, id: randomUUID(), time: "15:00" })),
  );
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
  const [{ id: actorId }] =
    await db`INSERT INTO users(company_id,name,role) VALUES(${a}::uuid,'Admin','ADMIN_EMPRESA') RETURNING id`;
  let session = actorId,
    company = a;
  const api = tsLoader({
    "@tanstack/react-router": { createFileRoute: () => (config) => config },
    "@/lib/pg.server": { getSql: () => db },
    "@/lib/session.server": { getSessionUserId: () => session },
    "@/lib/company.server": { requireCompanyId: async () => company },
  })("src/routes/api/clinic-agenda.ts").Route.server.handlers;
  const request = new Request("https://localhost/api/clinic-agenda?from=2026-10-28&to=2026-10-28");
  assert.equal((await api.GET({ request })).status, 200);
  session = null;
  assert.equal((await api.GET({ request })).status, 401);
  session = actorId;
  await db`UPDATE users SET role='ATENDENTE' WHERE id=${actorId}::uuid`;
  assert.equal((await api.GET({ request })).status, 403);
  await db`UPDATE users SET role='ADMIN_EMPRESA' WHERE id=${actorId}::uuid`;
  company = Response.json({ message: "Sem empresa" }, { status: 403 });
  assert.equal((await api.GET({ request })).status, 403);
  company = a;
  assert.equal(
    (
      await api.GET({
        request: new Request("https://localhost/api/clinic-agenda?from=2026-10-28&to=2027-10-28"),
      })
    ).status,
    422,
  );
  const invalid = new Request("https://localhost/api/clinic-agenda", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal((await api.POST({ request: invalid })).status, 422);
  await pg.exec("DROP TABLE public.clinic_appointments");
  assert.equal((await api.GET({ request })).status, 503);
  console.log(
    "PASS: API 401/403/422/503, limite de período, administrador, dupla reserva simultânea em banco isolado.",
  );
  console.log(
    "PASS: schema idempotente, isolamento por empresa, contato estrangeiro, conflitos, limites, cancelamento, versão, reenvio idempotente, bloqueios, horários livres e fuso. Banco isolado; nenhum envio externo.",
  );
} finally {
  await pg.close();
}
