import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Clock3, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ACCESS_PROFILE_LABEL, ACCESS_WEEKDAYS, type AccessProfile } from "@/lib/access-hours";

export const Route = createFileRoute("/_app/horarios-acesso")({
  component: HorariosAcessoPage,
  head: () => ({ meta: [{ title: "Horários de acesso — NexaBoot" }] }),
});

type Day = { weekday: number; blocked: boolean; startTime: string | null; endTime: string | null };
type ProfileRow = {
  profile: AccessProfile;
  enabled: boolean;
  forceLogoutOutsideSchedule: boolean;
  days: Day[];
};
type View = { timezone: string; adminGeralBypass: boolean; profiles: ProfileRow[] };

function HorariosAcessoPage() {
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    const res = await fetch("/api/access-hours", { credentials: "include" });
    if (!res.ok) {
      setView(null);
      return;
    }
    setView((await res.json()) as View);
  }, []);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  function patchProfile(profile: AccessProfile, patch: Partial<ProfileRow>) {
    setView((current) =>
      current
        ? {
            ...current,
            profiles: current.profiles.map((row) =>
              row.profile === profile ? { ...row, ...patch } : row,
            ),
          }
        : current,
    );
  }

  function patchDay(profile: AccessProfile, weekday: number, patch: Partial<Day>) {
    setView((current) =>
      current
        ? {
            ...current,
            profiles: current.profiles.map((row) =>
              row.profile !== profile
                ? row
                : {
                    ...row,
                    days: row.days.map((day) =>
                      day.weekday === weekday ? { ...day, ...patch } : day,
                    ),
                  },
            ),
          }
        : current,
    );
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!view) return;
    setSaving(true);
    try {
      const res = await fetch("/api/access-hours", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(view),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        toast.error(data.message ?? "Não foi possível salvar os horários.");
        return;
      }
      setView(data as View);
      toast.success("Horários de acesso salvos.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!view) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
        Você não pode configurar horários de acesso nesta empresa.
      </div>
    );
  }

  return (
    <form onSubmit={save} className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-start gap-3">
        <Clock3 className="mt-0.5 size-5 text-muted-foreground" />
        <div>
          <h1 className="text-lg font-semibold">Horários de acesso</h1>
          <p className="text-sm text-muted-foreground">
            Define quando cada perfil pode entrar. O que o perfil pode fazer continua nas permissões.
          </p>
        </div>
      </div>

      <section className="space-y-3 rounded-lg border bg-surface p-4">
        <label className="block text-sm">
          Fuso da empresa
          <input
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={view.timezone}
            onChange={(event) => setView({ ...view, timezone: event.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={view.adminGeralBypass}
            onChange={(event) => setView({ ...view, adminGeralBypass: event.target.checked })}
          />
          Admin geral pode acessar fora do horário
        </label>
      </section>

      {view.profiles.map((profile) => (
        <section key={profile.profile} className="space-y-3 rounded-lg border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium">{ACCESS_PROFILE_LABEL[profile.profile]}</h2>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={profile.enabled}
                onChange={(event) => patchProfile(profile.profile, { enabled: event.target.checked })}
              />
              Restrição ativa
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={profile.forceLogoutOutsideSchedule}
              onChange={(event) =>
                patchProfile(profile.profile, { forceLogoutOutsideSchedule: event.target.checked })
              }
            />
            Encerrar sessão ao sair da janela
          </label>
          <div className="space-y-2">
            {ACCESS_WEEKDAYS.map((weekday) => {
              const day = profile.days.find((item) => item.weekday === weekday.weekday);
              if (!day) return null;
              return (
                <div key={weekday.weekday} className="grid grid-cols-[8rem_auto_6rem_6rem] items-center gap-2 text-xs">
                  <span>{weekday.label}</span>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={day.blocked}
                      onChange={(event) =>
                        patchDay(profile.profile, weekday.weekday, { blocked: event.target.checked })
                      }
                    />
                    Bloqueado
                  </label>
                  <input
                    type="time"
                    disabled={day.blocked}
                    value={day.startTime ?? ""}
                    onChange={(event) =>
                      patchDay(profile.profile, weekday.weekday, { startTime: event.target.value })
                    }
                    className="rounded-md border bg-background px-2 py-1 disabled:opacity-50"
                  />
                  <input
                    type="time"
                    disabled={day.blocked}
                    value={day.endTime ?? ""}
                    onChange={(event) =>
                      patchDay(profile.profile, weekday.weekday, { endTime: event.target.value })
                    }
                    className="rounded-md border bg-background px-2 py-1 disabled:opacity-50"
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <button
        type="submit"
        disabled={saving}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
      >
        {saving && <Loader2 className="size-4 animate-spin" />}
        Salvar horários
      </button>
    </form>
  );
}
