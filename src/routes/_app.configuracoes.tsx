import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { isPlatformRole } from "@/lib/platform-roles";

export const Route = createFileRoute("/_app/configuracoes")({
  component: Settings,
});

function Settings() {
  const { user, companyValid, companyName } = useAuth();
  const allowed = isPlatformRole(user?.role) || user?.role === "ADMIN_EMPRESA";
  const [value, setValue] = useState({
    waiting_attendant_minutes: 10,
    waiting_customer_hours: 24,
    restrict_channels: false,
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!allowed || !companyValid) return;
    let cancelled = false;
    fetch("/api/company-operations")
      .then(async (r) => {
        if (!r.ok) throw Error();
        const data = await r.json();
        if (!cancelled) {
          setValue(data);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled)
          setMessage(
            "Não foi possível carregar. Confirme a migração de operações da empresa antes de configurar.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, companyValid]);
  if (!allowed)
    return <div className="p-6">Apenas o administrador pode alterar estas configurações.</div>;
  if (!companyValid) return <div className="p-6">Selecione uma empresa para configurar.</div>;
  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="text-xl font-semibold">Configurações de {companyName}</h1>
      <form
        className="mt-6 max-w-xl space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          try {
            const r = await fetch("/api/company-operations", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(value),
            });
            if (!r.ok) throw Error();
            setMessage("Configurações salvas.");
          } catch {
            setMessage("Não foi possível salvar as configurações.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block">
          Alerta aguardando atendente (minutos)
          <input
            className="mt-1 block rounded border p-2"
            type="number"
            required
            min={1}
            max={1440}
            value={value.waiting_attendant_minutes}
            onChange={(e) =>
              setValue({ ...value, waiting_attendant_minutes: Number(e.target.value) })
            }
          />
        </label>
        <label className="block">
          Alerta aguardando cliente (horas)
          <input
            className="mt-1 block rounded border p-2"
            type="number"
            required
            min={1}
            max={720}
            value={value.waiting_customer_hours}
            onChange={(e) => setValue({ ...value, waiting_customer_hours: Number(e.target.value) })}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Estes prazos geram alertas. Conversas humanas não serão encerradas automaticamente.
        </p>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.restrict_channels}
            onChange={(e) => setValue({ ...value, restrict_channels: e.target.checked })}
          />
          Exigir liberação de números por usuário ou equipe
        </label>
        <p className="text-sm text-muted-foreground">
          Cadastre as liberações em Equipes e números antes de ativar. Administradores da empresa e
          suporte da plataforma mantêm acesso.
        </p>
        <button
          disabled={busy || !loaded}
          className="rounded bg-emerald-700 px-4 py-2 text-white disabled:opacity-40"
        >
          {busy ? "Salvando…" : "Salvar"}
        </button>
        <p role="status">{message}</p>
      </form>
    </div>
  );
}
