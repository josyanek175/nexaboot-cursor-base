import { Link, useRouterState } from "@tanstack/react-router";

const TABS = [
  { to: "/gerencial", label: "Visão Geral", end: true },
  { to: "/gerencial/resultados", label: "Resultados", end: false },
  { to: "/gerencial/custos", label: "Custos", end: false },
  { to: "/gerencial/bloqueados", label: "Bloqueados", end: false },
] as const;

export function GerencialTabs() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });

  return (
    <nav className="flex flex-wrap gap-1 border-b border-border">
      {TABS.map((tab) => {
        const active = tab.end
          ? pathname === "/gerencial" || pathname === "/gerencial/"
          : pathname === tab.to || pathname.startsWith(tab.to + "/");
        return (
          <Link
            key={tab.to}
            to={tab.to}
            className={`-mb-px rounded-t-md px-4 py-2.5 text-sm font-medium transition-colors ${
              active
                ? "border-b-2 border-whatsapp bg-whatsapp/5 text-whatsapp"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
