import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";

const FLOW_ADMIN_ROLES = new Set(["SUPER_ADMIN", "TI", "ADMIN_GERAL", "ADMIN_EMPRESA"]);

export const Route = createFileRoute("/_app/lembretes")({
  component: LembretesPage,
  head: () => ({ meta: [{ title: "Lembretes — NexaBoot" }] }),
});

type Reminder = {
  id: string;
  label: string;
  days: number;
  due_at: string;
  flow_name: string;
  contact_name: string | null;
  phone: string | null;
  channel_name: string | null;
};

function LembretesPage() {
  const { user } = useAuth();
  const allowed = FLOW_ADMIN_ROLES.has(String(user?.role ?? ""));
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const res = await fetch("/api/automation-flows?view=reminders", { credentials: "include" });
    if (!res.ok) return;
    setReminders(((await res.json()) as { reminders: Reminder[] }).reminders ?? []);
  }, []);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  async function act(action: "resend" | "dismiss", id: string) {
    const res = await fetch("/api/automation-flows", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id }),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) {
      toast.error(body.message ?? "Não foi possível atualizar o lembrete.");
      return;
    }
    toast.success(action === "resend" ? "Mensagem reenviada." : "Lembrete dispensado.");
    await reload();
  }

  if (!allowed) {
    return <div className="p-6 text-sm text-muted-foreground">Você não tem acesso a Lembretes.</div>;
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Lembretes</h1>
        <p className="text-sm text-muted-foreground">
          O WhatsApp não dispara sozinho. Reenvie a primeira mensagem do fluxo ou dispense.
        </p>
      </div>
      {loading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {!loading && reminders.length === 0 && (
        <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">Nenhum lembrete aguardando decisão.</p>
      )}
      <ul className="flex flex-col gap-2">
        {reminders.map((reminder) => {
          const due = new Date(reminder.due_at);
          const ready = due.getTime() <= Date.now();
          return (
            <li key={reminder.id} className="rounded-md border border-border bg-card px-4 py-3">
              <div className="font-medium">{reminder.contact_name || reminder.phone}</div>
              <div className="text-xs text-muted-foreground">
                {reminder.flow_name} · {reminder.channel_name} · {reminder.label} · {due.toLocaleString("pt-BR")}
                {ready ? " · para decidir" : ""}
              </div>
              <div className="mt-2 flex gap-2">
                <button className="rounded-md bg-whatsapp px-3 py-1.5 text-xs text-whatsapp-foreground" onClick={() => void act("resend", reminder.id)}>
                  Reenviar
                </button>
                <button className="rounded-md bg-muted px-3 py-1.5 text-xs" onClick={() => void act("dismiss", reminder.id)}>
                  Dispensar
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
