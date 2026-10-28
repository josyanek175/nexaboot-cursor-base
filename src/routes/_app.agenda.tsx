import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Clock,
  CheckCircle2,
  Users,
  Copy,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AGENDA_ROLES,
  agendaToday,
  moveDate,
  availableSlots,
  endTime,
  reminderText,
  statuses,
  appointmentSchema,
  professionalSchema,
  type Appointment,
  type AppointmentInput,
  type Professional,
  type ProfessionalInput,
} from "@/lib/clinic-agenda";

export const Route = createFileRoute("/_app/agenda")({
  component: AgendaPage,
  head: () => ({ meta: [{ title: "Agenda — NexaBoot" }] }),
});
const field = "h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm";
const button =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted disabled:opacity-50";
const primary = `${button} border-transparent bg-primary text-primary-foreground hover:opacity-90 hover:bg-primary`;
const badge: Record<string, string> = {
  scheduled: "bg-amber-100 text-amber-900",
  confirmed: "bg-emerald-100 text-emerald-900",
  arrived: "bg-blue-100 text-blue-900",
  completed: "bg-slate-100 text-slate-700",
  absent: "bg-red-100 text-red-800",
  cancelled: "bg-gray-100 text-gray-600",
};
const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const emptyProfessional: ProfessionalInput = {
  name: "",
  specialty: "",
  duration: 30,
  opens: "08:00",
  closes: "18:00",
  weekdays: [1, 2, 3, 4, 5],
};
type Contact = { id: string; name: string; phone: string };
function dayLabel(day: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(day + "T12:00:00Z"));
}
function demoData(date: string) {
  const professionals: Professional[] = [
    {
      id: "a1111111-1111-4111-8111-111111111111",
      name: "Dra. Helena · demonstração",
      specialty: "Clínica geral",
      duration: 30,
      opens: "08:00",
      closes: "18:00",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    {
      id: "a2222222-2222-4222-8222-222222222222",
      name: "Dr. Rafael · demonstração",
      specialty: "Cardiologia",
      duration: 45,
      opens: "08:00",
      closes: "18:00",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
  ];
  const appointments: Appointment[] = [
    {
      id: crypto.randomUUID(),
      professionalId: professionals[0].id,
      date,
      time: "09:00",
      duration: 30,
      kind: "appointment",
      patient: "Ana · paciente fictícia",
      phone: "",
      contactId: null,
      service: "Consulta",
      status: "confirmed",
      reminderHours: 24,
      version: 1,
      professionalName: professionals[0].name,
      reminderCopiedAt: null,
    },
    {
      id: crypto.randomUUID(),
      professionalId: professionals[1].id,
      date,
      time: "10:00",
      duration: 45,
      kind: "appointment",
      patient: "João · paciente fictício",
      phone: "",
      contactId: null,
      service: "Retorno",
      status: "scheduled",
      reminderHours: 24,
      version: 1,
      professionalName: professionals[1].name,
      reminderCopiedAt: null,
    },
    {
      id: crypto.randomUUID(),
      professionalId: professionals[0].id,
      date,
      time: "12:00",
      duration: 60,
      kind: "block",
      patient: "",
      phone: "",
      contactId: null,
      service: "Intervalo",
      status: "scheduled",
      reminderHours: 0,
      version: 1,
      professionalName: professionals[0].name,
      reminderCopiedAt: null,
    },
  ];
  return { professionals, appointments };
}
function AgendaPage() {
  const { user, companyId, companyName, companyValid } = useAuth();
  const allowed = AGENDA_ROLES.includes(String(user?.role));
  const [date, setDate] = useState(agendaToday);
  const [view, setView] = useState<"day" | "week" | "confirmations">("day");
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [professionalFilter, setProfessionalFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  const [draft, setDraft] = useState<AppointmentInput | null>(null);
  const [proDraft, setProDraft] = useState<ProfessionalInput | null>(null);
  const [formError, setFormError] = useState("");
  const [contactQuery, setContactQuery] = useState(""),
    [contacts, setContacts] = useState<Contact[]>([]);
  const [contactLoading, setContactLoading] = useState(false);
  const [reminder, setReminder] = useState<Appointment | null>(null);
  const [copied, setCopied] = useState(false);
  const epoch = useRef(0),
    contactsEpoch = useRef(0);
  const activeCompany = useRef(companyId);
  activeCompany.current = companyId;
  const renderedCompany = useRef(companyId);
  const sameCompany = renderedCompany.current === companyId;
  const rangeEnd = view === "week" ? moveDate(date, 6) : date;
  useEffect(() => {
    renderedCompany.current = companyId;
    epoch.current++;
    contactsEpoch.current++;
    setDraft(null);
    setProDraft(null);
    setReminder(null);
    setAppointments([]);
    setProfessionals([]);
    setProfessionalFilter("");
    setDemo(false);
  }, [companyId]);
  useEffect(() => {
    contactsEpoch.current++;
    setContacts([]);
    setContactLoading(false);
  }, [draft?.id]);
  async function reload(signal?: AbortSignal) {
    const requestEpoch = ++epoch.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/clinic-agenda?from=${date}&to=${rangeEnd}`, {
        credentials: "include",
        signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Não foi possível carregar a agenda.");
      if (epoch.current === requestEpoch) {
        setProfessionals(data.professionals);
        setAppointments(data.appointments);
      }
    } catch (e) {
      if (epoch.current === requestEpoch && !signal?.aborted) {
        setError(e instanceof Error ? e.message : "Falha ao carregar");
        setAppointments([]);
        setProfessionals([]);
      }
    } finally {
      if (epoch.current === requestEpoch) setLoading(false);
    }
  }
  useEffect(() => {
    if (!allowed || !companyValid || demo) return;
    const controller = new AbortController();
    void reload(controller.signal);
    return () => {
      controller.abort();
      epoch.current++;
    };
  }, [date, rangeEnd, companyId, allowed, companyValid, demo]);
  async function post(action: string, data: unknown) {
    const res = await fetch("/api/clinic-agenda", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.message || "Não foi possível salvar.");
    return result;
  }
  function openAppointment(kind: "appointment" | "block" = "appointment") {
    setFormError("");
    setContacts([]);
    setContactQuery("");
    const p = professionals.find((p) => p.id === professionalFilter) || professionals[0];
    const slot = p ? availableSlots(p, date, appointments)[0] : "09:00";
    setDraft({
      id: crypto.randomUUID(),
      professionalId: p?.id || "",
      date,
      time: slot || p?.opens || "09:00",
      duration: p?.duration || 30,
      kind,
      patient: "",
      phone: "",
      contactId: null,
      service: kind === "block" ? "Bloqueio de horário" : "Consulta",
      status: "scheduled",
      reminderHours: kind === "block" ? 0 : 24,
    });
  }
  async function saveAppointment(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || saving) return;
    const validated = appointmentSchema.safeParse(draft);
    if (!validated.success) {
      setFormError(validated.error.issues[0].message);
      return;
    }
    const p = professionals.find((p) => p.id === draft.professionalId);
    if (!p) {
      setFormError("Selecione um profissional.");
      return;
    }
    if (
      draft.status !== "cancelled" &&
      !availableSlots(
        p,
        draft.date,
        appointments.filter((a) => a.id !== draft.id),
        draft.duration,
      ).includes(draft.time)
    ) {
      setFormError("Horário indisponível. Escolha outro horário ou atualize a agenda.");
      return;
    }
    setSaving(true);
    setFormError("");
    const tenant = companyId;
    try {
      if (demo)
        setAppointments((old) => [
          ...old.filter((a) => a.id !== draft.id),
          {
            ...draft,
            version: (draft.version || 0) + 1,
            professionalName: p.name,
            reminderCopiedAt: null,
          },
        ]);
      else await post("save", validated.data);
      if (tenant !== activeCompany.current) return;
      setDraft(null);
      toast.success(demo ? "Agendamento simulado." : "Agendamento salvo.");
      if (!demo) await reload();
    } catch (e) {
      if (tenant === activeCompany.current)
        setFormError(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }
  async function saveProfessional(e: React.FormEvent) {
    e.preventDefault();
    if (!proDraft || saving) return;
    const result = professionalSchema.safeParse(proDraft);
    if (!result.success) {
      setFormError(result.error.issues[0].message);
      return;
    }
    setSaving(true);
    setFormError("");
    const tenant = companyId;
    try {
      if (demo) setProfessionals((old) => [...old, { ...result.data, id: crypto.randomUUID() }]);
      else await post("professional", result.data);
      if (tenant !== activeCompany.current) return;
      setProDraft(null);
      toast.success("Profissional cadastrado.");
      if (!demo) await reload();
    } catch (e) {
      if (tenant === activeCompany.current)
        setFormError(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }
  async function findContacts() {
    if (demo || contactQuery.trim().length < 2) return;
    const token = ++contactsEpoch.current;
    setContactLoading(true);
    try {
      const res = await fetch(`/api/contacts?q=${encodeURIComponent(contactQuery.trim())}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Não foi possível buscar contatos.");
      const data = await res.json();
      if (token === contactsEpoch.current) {
        setContacts(data.contacts || []);
        if (!data.contacts?.length)
          toast.info("Nenhum contato encontrado. Você pode preencher manualmente.");
      }
    } catch {
      toast.error("Não foi possível buscar contatos.");
    } finally {
      if (token === contactsEpoch.current) setContactLoading(false);
    }
  }
  if (!sameCompany)
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Carregando a agenda da empresa selecionada…
      </p>
    );
  if (!allowed || !companyValid)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Selecione uma empresa e entre com um perfil administrativo para validar a agenda piloto.
      </div>
    );
  const filtered = appointments.filter(
    (a) =>
      (!professionalFilter || a.professionalId === professionalFilter) &&
      `${a.patient} ${a.phone} ${a.service}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const patients = filtered.filter((a) => a.kind === "appointment" && a.status !== "cancelled");
  const days = Array.from({ length: view === "week" ? 7 : 1 }, (_, i) => moveDate(date, i));
  const draftProfessional = professionals.find((p) => p.id === draft?.professionalId);
  const slots =
    draft && draftProfessional
      ? availableSlots(
          draftProfessional,
          draft.date,
          appointments.filter((a) => a.id !== draft.id),
          draft.duration,
        )
      : [];
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-background lg:overflow-hidden">
      <header className="shrink-0 border-b border-border bg-card p-3 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <CalendarDays className="text-primary" size={24} />
              <h1 className="text-xl font-semibold">Agenda</h1>
              <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">
                Piloto
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Consultas, equipe e confirmações em um só lugar.
            </p>
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <button
              className={button}
              disabled={loading || saving || (!!error && !demo)}
              onClick={() => {
                setFormError("");
                setProDraft({ ...emptyProfessional });
              }}
            >
              Profissionais
            </button>
            <button
              className={button}
              disabled={!professionals.length || loading || !!error}
              onClick={() => openAppointment("block")}
            >
              Bloquear horário
            </button>
            <button
              className={primary}
              disabled={!professionals.length || loading || !!error}
              onClick={() => openAppointment()}
            >
              <Plus size={17} />
              Nova consulta
            </button>
          </div>
        </div>
        {demo && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <span>
              <strong>Demonstração.</strong> Dados fictícios; alterações só nesta tela.
            </span>
            <button
              className={button}
              onClick={() => {
                setDemo(false);
                setDraft(null);
                setAppointments([]);
                setProfessionals([]);
              }}
            >
              Sair da demonstração
            </button>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            className={button}
            aria-label="Período anterior"
            onClick={() => setDate(moveDate(date, view === "week" ? -7 : -1))}
          >
            <ChevronLeft size={18} />
          </button>
          <input
            aria-label="Data da agenda"
            type="date"
            className={`${field} w-auto max-w-[160px]`}
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
          <button
            className={button}
            aria-label="Próximo período"
            onClick={() => setDate(moveDate(date, view === "week" ? 7 : 1))}
          >
            <ChevronRight size={18} />
          </button>
          <button className={button} onClick={() => setDate(agendaToday())}>
            Hoje
          </button>
          <span className="text-xs text-muted-foreground">Horário de Brasília</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[auto_1fr_1fr]">
          <div className="flex rounded-lg bg-muted p-1">
            {(
              [
                ["day", "Dia"],
                ["week", "7 dias"],
                ["confirmations", "Confirmações"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                aria-pressed={view === key}
                className={`min-h-10 flex-1 rounded-md px-3 text-sm ${view === key ? "bg-card font-semibold shadow-sm" : ""}`}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            aria-label="Filtrar profissional"
            className={field}
            value={professionalFilter}
            onChange={(e) => setProfessionalFilter(e.target.value)}
          >
            <option value="">Todos os profissionais</option>
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            className={field}
            aria-label="Buscar paciente"
            placeholder="Buscar paciente, telefone ou serviço"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </header>
      <main className="shrink-0 p-3 sm:p-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {loading && (
          <p role="status" className="py-8 text-center text-muted-foreground">
            Carregando agenda…
          </p>
        )}
        {error && !demo && (
          <div
            role="alert"
            className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950"
          >
            <h2 className="font-semibold">Agenda ainda não disponível</h2>
            <p className="mt-2 text-sm">{error}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className={button} onClick={() => void reload()}>
                Tentar novamente
              </button>
              <button
                className={primary}
                onClick={() => {
                  epoch.current++;
                  const data = demoData(date);
                  setDemo(true);
                  setError("");
                  setLoading(false);
                  setProfessionals(data.professionals);
                  setAppointments(data.appointments);
                }}
              >
                Conhecer com dados fictícios
              </button>
            </div>
          </div>
        )}
        {!loading && !error && (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                ["Consultas", patients.length, Users],
                [
                  "Confirmadas",
                  patients.filter((a) => a.status === "confirmed").length,
                  CheckCircle2,
                ],
                [
                  "Aguardando confirmação",
                  patients.filter((a) => a.status === "scheduled").length,
                  Clock,
                ],
                [
                  "Concluídas",
                  patients.filter((a) => a.status === "completed").length,
                  CalendarDays,
                ],
              ].map(([label, value, Icon]) => {
                const I = Icon as typeof Users;
                return (
                  <div key={String(label)} className="rounded-xl border border-border bg-card p-3">
                    <I size={18} className="mb-2 text-primary" />
                    <p className="text-2xl font-semibold">{String(value)}</p>
                    <p className="text-xs text-muted-foreground">{String(label)}</p>
                  </div>
                );
              })}
            </div>
            {!professionals.length ? (
              <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
                <CalendarDays className="mx-auto mb-3 text-primary" size={32} />
                <h2 className="font-semibold">Prepare sua primeira agenda</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                  Cadastre um profissional, escolha os dias de atendimento e a duração padrão das
                  consultas.
                </p>
                <button
                  className={`${primary} mt-4`}
                  onClick={() => {
                    setFormError("");
                    setProDraft({ ...emptyProfessional });
                  }}
                >
                  Cadastrar profissional
                </button>
              </div>
            ) : view === "confirmations" ? (
              <section className="space-y-3">
                <div className="rounded-xl border border-border bg-card p-4">
                  <h2 className="font-semibold">Confirmações do dia selecionado</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Prepare a mensagem e copie para o atendimento. Copiar não envia ao paciente. O
                    status só muda quando a equipe registrar a resposta.
                  </p>
                </div>
                {patients
                  .filter((a) => a.status === "scheduled" && a.reminderHours > 0)
                  .map((a) => (
                    <article
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"
                    >
                      <div className="min-w-0">
                        <h3 className="break-words font-medium">{a.patient}</h3>
                        <p className="text-sm text-muted-foreground">
                          {a.time} · {a.professionalName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Planejado para {a.reminderHours}h antes · envio manual
                        </p>
                      </div>
                      <button
                        className={button}
                        onClick={() => {
                          setReminder(a);
                          setCopied(false);
                        }}
                      >
                        <Copy size={16} />
                        Preparar lembrete
                      </button>
                    </article>
                  ))}
                {!patients.some((a) => a.status === "scheduled" && a.reminderHours > 0) && (
                  <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
                    Nenhuma confirmação pendente com lembrete neste dia.
                  </p>
                )}
              </section>
            ) : (
              <div className={`grid gap-4 ${view === "week" ? "xl:grid-cols-2" : ""}`}>
                {days.map((day) => {
                  const items = filtered
                    .filter((a) => a.date === day)
                    .sort((a, b) => a.time.localeCompare(b.time));
                  return (
                    <section key={day} className="min-w-0">
                      <h2 className="mb-3 font-semibold capitalize">{dayLabel(day)}</h2>
                      <div className="space-y-2">
                        {items.map((a) => (
                          <article
                            key={a.id}
                            className={`rounded-xl border border-border bg-card p-4 ${a.status === "cancelled" ? "opacity-60" : ""}`}
                          >
                            <div className="flex items-start gap-3">
                              <div className="w-14 shrink-0 border-r border-border pr-3">
                                <p className="font-semibold">{a.time}</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {endTime(a.time, a.duration)}
                                </p>
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <h3 className="break-words font-semibold">
                                    {a.kind === "block" ? a.service : a.patient}
                                  </h3>
                                  <span
                                    className={`rounded-full px-2 py-1 text-xs ${a.kind === "block" ? "bg-slate-200 text-slate-800" : badge[a.status]}`}
                                  >
                                    {a.kind === "block"
                                      ? a.status === "cancelled"
                                        ? "Bloqueio cancelado"
                                        : "Bloqueio"
                                      : statuses[a.status]}
                                  </span>
                                </div>
                                <p className="mt-1 break-words text-sm text-muted-foreground">
                                  {a.professionalName}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  {a.kind === "block" ? `${a.duration} minutos` : a.service}
                                  {a.phone ? ` · ${a.phone}` : ""}
                                </p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    className={button}
                                    onClick={() => {
                                      setDraft({ ...a });
                                      setFormError("");
                                      setContactQuery("");
                                      setContacts([]);
                                    }}
                                  >
                                    Ver / editar
                                  </button>
                                  {a.kind === "appointment" &&
                                    ["scheduled", "confirmed"].includes(a.status) && (
                                      <button
                                        className={button}
                                        onClick={() => {
                                          setReminder(a);
                                          setCopied(false);
                                        }}
                                      >
                                        Lembrete
                                      </button>
                                    )}
                                </div>
                              </div>
                            </div>
                          </article>
                        ))}
                        {!items.length && (
                          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                            Nenhum agendamento neste dia.
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
            <p className="mt-5 text-xs text-muted-foreground">
              Agenda administrativa. Não registre diagnósticos, exames ou prontuários. Lembretes
              automáticos e confirmação por botão serão uma próxima etapa.
            </p>
          </>
        )}
      </main>
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setDraft(null);
            contactsEpoch.current++;
          }
        }}
      >
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {draft?.version
                ? "Editar agendamento"
                : draft?.kind === "block"
                  ? "Bloquear horário"
                  : "Nova consulta"}
            </DialogTitle>
            <DialogDescription>
              {demo
                ? "Demonstração: nenhuma alteração será gravada no banco."
                : "Horários em Brasília. O sistema confere conflitos ao salvar."}
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form onSubmit={saveAppointment} className="space-y-4">
              <label className="block text-sm">
                Profissional
                <select
                  className={`${field} mt-1`}
                  required
                  value={draft.professionalId}
                  onChange={(e) => {
                    const p = professionals.find((p) => p.id === e.target.value);
                    setDraft({
                      ...draft,
                      professionalId: e.target.value,
                      duration: p?.duration || 30,
                    });
                  }}
                >
                  <option value="">Selecione</option>
                  {professionals.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.specialty}
                    </option>
                  ))}
                </select>
              </label>
              {draft.kind === "appointment" && (
                <>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-sm font-medium">Vincular contato existente (opcional)</p>
                    <div className="mt-2 flex gap-2">
                      <input
                        aria-label="Nome ou telefone do contato"
                        className={field}
                        disabled={demo || saving}
                        value={contactQuery}
                        onChange={(e) => {
                          contactsEpoch.current++;
                          setContactLoading(false);
                          setContactQuery(e.target.value);
                          setContacts([]);
                        }}
                        placeholder={demo ? "Indisponível na demonstração" : "Nome ou telefone"}
                      />
                      <button
                        type="button"
                        aria-label="Buscar contato"
                        className={button}
                        disabled={demo || contactLoading || contactQuery.trim().length < 2}
                        onClick={() => void findContacts()}
                      >
                        <Search size={17} />
                      </button>
                    </div>
                    {contacts.length > 0 && (
                      <ul className="mt-2 max-h-40 overflow-y-auto">
                        {contacts.map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              className="min-h-11 w-full rounded p-2 text-left text-sm hover:bg-muted"
                              onClick={() => {
                                setDraft({
                                  ...draft,
                                  contactId: c.id,
                                  patient: c.name || "",
                                  phone: c.phone || "",
                                });
                                setContacts([]);
                                setContactQuery("");
                              }}
                            >
                              {c.name} · {c.phone}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {draft.contactId && (
                      <p className="mt-2 text-xs text-primary">
                        Contato vinculado{" "}
                        <button
                          type="button"
                          className="ml-2 min-h-8 underline"
                          onClick={() => setDraft({ ...draft, contactId: null })}
                        >
                          Desvincular
                        </button>
                      </p>
                    )}
                  </div>
                  <label className="block text-sm">
                    Paciente
                    <input
                      className={`${field} mt-1`}
                      required
                      maxLength={120}
                      value={draft.patient}
                      onChange={(e) => setDraft({ ...draft, patient: e.target.value })}
                    />
                  </label>
                  <label className="block text-sm">
                    Telefone
                    <input
                      className={`${field} mt-1`}
                      type="tel"
                      maxLength={25}
                      value={draft.phone}
                      onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                    />
                  </label>
                </>
              )}
              <label className="block text-sm">
                {draft.kind === "block" ? "Descrição do bloqueio" : "Serviço"}
                <input
                  className={`${field} mt-1`}
                  required
                  maxLength={100}
                  value={draft.service}
                  onChange={(e) => setDraft({ ...draft, service: e.target.value })}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="min-w-0 text-sm">
                  Data
                  <input
                    type="date"
                    required
                    className={`${field} mt-1`}
                    value={draft.date}
                    onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                  />
                </label>
                <label className="min-w-0 text-sm">
                  Horário
                  <input
                    type="time"
                    required
                    className={`${field} mt-1`}
                    value={draft.time}
                    onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                  />
                </label>
                <label className="min-w-0 text-sm">
                  Duração (min)
                  <input
                    type="number"
                    min={5}
                    max={180}
                    required
                    className={`${field} mt-1`}
                    value={draft.duration}
                    onChange={(e) => setDraft({ ...draft, duration: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <p className="text-xs font-medium">Sugestões livres para esta duração</p>
                <div className="mt-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto">
                  {slots
                    .filter((t) => Number(t.slice(3)) % 15 === 0)
                    .map((t) => (
                      <button
                        type="button"
                        className={`${button} ${draft.time === t ? "border-primary text-primary" : ""}`}
                        key={t}
                        onClick={() => setDraft({ ...draft, time: t })}
                      >
                        {t}
                      </button>
                    ))}
                  {!slots.length && (
                    <p className="text-xs text-muted-foreground">
                      Sem horários livres. Confira a data e o expediente.
                    </p>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Se mudar a data, salve para o servidor conferir a disponibilidade atual.
                </p>
              </div>
              <label className="block text-sm">
                Status
                <select
                  className={`${field} mt-1`}
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({ ...draft, status: e.target.value as AppointmentInput["status"] })
                  }
                >
                  {Object.entries(statuses)
                    .filter(
                      ([k]) => draft.kind !== "block" || ["scheduled", "cancelled"].includes(k),
                    )
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {draft.kind === "block" && k === "scheduled" ? "Bloqueado" : v}
                      </option>
                    ))}
                </select>
              </label>
              {draft.kind === "appointment" && (
                <label className="block text-sm">
                  Planejar lembrete
                  <select
                    className={`${field} mt-1`}
                    value={draft.reminderHours}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        reminderHours: Number(e.target.value) as 0 | 2 | 24 | 48,
                      })
                    }
                  >
                    <option value={0}>Sem lembrete</option>
                    <option value={2}>2 horas antes</option>
                    <option value={24}>24 horas antes</option>
                    <option value={48}>48 horas antes</option>
                  </select>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Nesta versão, a equipe prepara e envia a mensagem manualmente.
                  </span>
                </label>
              )}
              {formError && (
                <p
                  role="alert"
                  className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {formError}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className={button}
                  disabled={saving}
                  onClick={() => setDraft(null)}
                >
                  Cancelar
                </button>
                <button type="submit" className={primary} disabled={saving}>
                  {saving ? "Salvando…" : "Salvar agendamento"}
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!proDraft}
        onOpenChange={(open) => {
          if (!open && !saving) setProDraft(null);
        }}
      >
        <DialogContent className="max-h-[92dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Cadastrar profissional</DialogTitle>
            <DialogDescription>
              Defina o expediente e a duração padrão. Cada profissional tem sua própria
              disponibilidade.
            </DialogDescription>
          </DialogHeader>
          {proDraft && (
            <form className="space-y-4" onSubmit={saveProfessional}>
              <label className="block text-sm">
                Nome
                <input
                  required
                  maxLength={100}
                  className={`${field} mt-1`}
                  value={proDraft.name}
                  onChange={(e) => setProDraft({ ...proDraft, name: e.target.value })}
                />
              </label>
              <label className="block text-sm">
                Especialidade
                <input
                  maxLength={80}
                  className={`${field} mt-1`}
                  value={proDraft.specialty}
                  onChange={(e) => setProDraft({ ...proDraft, specialty: e.target.value })}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="min-w-0 text-sm">
                  Início
                  <input
                    type="time"
                    required
                    className={`${field} mt-1`}
                    value={proDraft.opens}
                    onChange={(e) => setProDraft({ ...proDraft, opens: e.target.value })}
                  />
                </label>
                <label className="min-w-0 text-sm">
                  Fim
                  <input
                    type="time"
                    required
                    className={`${field} mt-1`}
                    value={proDraft.closes}
                    onChange={(e) => setProDraft({ ...proDraft, closes: e.target.value })}
                  />
                </label>
              </div>
              <fieldset>
                <legend className="text-sm">Dias de atendimento</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {weekdays.map((label, i) => (
                    <label
                      key={i}
                      className="flex min-h-11 items-center gap-1 rounded-lg border px-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={proDraft.weekdays.includes(i)}
                        onChange={(e) =>
                          setProDraft({
                            ...proDraft,
                            weekdays: e.target.checked
                              ? [...proDraft.weekdays, i]
                              : proDraft.weekdays.filter((d) => d !== i),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="block text-sm">
                Duração padrão (minutos)
                <input
                  type="number"
                  min={5}
                  max={180}
                  required
                  className={`${field} mt-1`}
                  value={proDraft.duration}
                  onChange={(e) => setProDraft({ ...proDraft, duration: Number(e.target.value) })}
                />
              </label>
              {formError && (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}
              <button className={primary} disabled={saving} type="submit">
                {saving ? "Salvando…" : "Cadastrar profissional"}
              </button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={!!reminder} onOpenChange={(open) => !open && setReminder(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Preparar lembrete</DialogTitle>
            <DialogDescription>
              Revise antes de enviar. Nenhuma mensagem é disparada por esta tela.
            </DialogDescription>
          </DialogHeader>
          {reminder && (
            <>
              <textarea
                aria-label="Mensagem de lembrete"
                readOnly
                className="min-h-40 w-full rounded-lg border border-border bg-muted p-3 text-sm"
                value={reminderText(
                  reminder,
                  demo ? "Clínica de demonstração" : companyName || "clínica",
                )}
              />
              <button
                className={primary}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      reminderText(
                        reminder,
                        demo ? "Clínica de demonstração" : companyName || "clínica",
                      ),
                    );
                    setCopied(true);
                  } catch {
                    toast.error("Selecione e copie o texto manualmente.");
                  }
                }}
              >
                <Copy size={16} />
                {copied ? "Texto copiado — ainda não enviado" : "Copiar mensagem"}
              </button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
