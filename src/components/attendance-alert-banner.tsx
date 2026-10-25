import { useEffect, useState } from "react";
export function AttendanceAlertBanner({ companyId }: { companyId: string | null }) {
  const [alerts, setAlerts] = useState<
    { id: string; name: string | null; waiting_for: string; waiting_since: string }[]
  >([]);
  const [counts, setCounts] = useState({ attendant: 0, customer: 0 });
  useEffect(() => {
    let cancelled = false;
    if (!companyId) return;
    async function load() {
      try {
        const r = await fetch("/api/attendance-alerts", { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) {
          setAlerts(data.alerts);
          setCounts({
            attendant: data.alerts.filter(
              (a: { waiting_for: string }) => a.waiting_for === "attendant",
            ).length,
            customer: data.alerts.filter(
              (a: { waiting_for: string }) => a.waiting_for === "customer",
            ).length,
          });
        }
      } catch {
        /* Next polling retries. */
      }
    }
    void load();
    const timer = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [companyId]);
  if (!counts.attendant && !counts.customer) return null;
  return (
    <details className="shrink-0 border-b bg-amber-50 px-4 py-2 text-sm text-amber-950">
      <summary className="cursor-pointer" role="status">
        Pendências listadas: {counts.attendant} aguardando atendente · {counts.customer} aguardando
        cliente além do prazo{alerts.length === 100 ? " (100 mais antigas)" : ""}.
      </summary>
      <ul className="mt-2 max-h-44 space-y-1 overflow-auto">
        {alerts.map((a) => (
          <li key={a.id}>
            <a className="underline" href={"/atendimento?c=" + encodeURIComponent(a.id)}>
              {a.name || "Cliente"} · aguardando{" "}
              {a.waiting_for === "attendant" ? "atendente" : "cliente"} desde{" "}
              {new Date(a.waiting_since).toLocaleString("pt-BR")}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
