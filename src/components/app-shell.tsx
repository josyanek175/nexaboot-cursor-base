import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  MessagesSquare,
  Users,
  Building2,
  Smartphone,
  Workflow,
  Waypoints,
  Bell,
  MessageCircleMore,
  Contact2,
  Settings,
  ScrollText,
  LogOut,
  Menu,
  X,
  UsersRound,
  Megaphone,
  Clock3,
  ChartColumn,
  CalendarDays,
} from "lucide-react";
import { canManageInternalGroups } from "@/lib/current-user";
import {
  canAccessCampaignsModule,
  canViewCampaignCosts,
  actingUserFromAuth,
} from "@/lib/permissions";
import { useEffect, useRef, useState } from "react";
import type { Role } from "@/lib/mocks";
import { subscribeUnread, setUnread as setUnreadStore, type UnreadKey } from "@/lib/unread-store";
import {
  onInternalUnreadCountUpdate,
  unlockNotificationAudio,
  resetInternalUnreadBaseline,
} from "@/lib/notification-sound";
import { SessionProvider, useSession } from "@/lib/session";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { AttendanceAlertBanner } from "@/components/attendance-alert-banner";
import { SidebarNavigation } from "@/components/sidebar-navigation";
import { useMobileViewportHeight } from "@/hooks/use-mobile-viewport-height";

const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super Admin · Plataforma",
  ADMIN_GERAL: "Super-Admin (plataforma)",
  TI: "TI · Plataforma",
  ADMIN_EMPRESA: "Admin Empresa",
  GERENTE: "Gerente",
  SUPERVISOR: "Supervisor",
  ATENDENTE_GERAL: "Atendente Geral",
  ATENDENTE: "Atendente",
};
const roleLabel = (r: Role) => ROLE_LABELS[r] ?? r;

const OPERATIONAL_PREFIXES = [
  "/dashboard",
  "/espera",
  "/usuarios",
  "/equipes-numeros",
  "/grupos-internos",
  "/comunicacao-interna",
  "/fluxos",
  "/lembretes",
  "/agenda",
  "/horarios-acesso",
  "/atendimento",
  "/contatos",
  "/canais",
  "/campanhas",
  "/gerencial",
];
function isOperationalPath(pathname: string): boolean {
  return OPERATIONAL_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  badgeKey?: UnreadKey;
  adminOnly?: boolean;
  campaignsOnly?: boolean;
  gerencialOnly?: boolean;
  waitOnly?: boolean;
  accessHours?: boolean;
  flows?: boolean;
  reminders?: boolean;
};

type CompanyOption = { id: string; name: string };

const nav: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/espera", label: "Tempo de espera", icon: Clock3, waitOnly: true },
  {
    to: "/atendimento",
    label: "Atendimento",
    icon: MessagesSquare,
    badgeKey: "atendimento" as UnreadKey,
  },
  {
    to: "/comunicacao-interna",
    label: "Comunicação Interna",
    icon: MessageCircleMore,
    badgeKey: "internal" as UnreadKey,
  },
  { to: "/grupos-internos", label: "Grupos Internos", icon: UsersRound, adminOnly: true },
  { to: "/contatos", label: "Contatos", icon: Contact2 },
  { to: "/campanhas", label: "Campanhas", icon: Megaphone, campaignsOnly: true },
  { to: "/gerencial", label: "Gerencial", icon: ChartColumn, gerencialOnly: true },
  { to: "/fluxos", label: "Fluxos", icon: Waypoints, flows: true },
  { to: "/lembretes", label: "Lembretes", icon: Bell, reminders: true },
  { to: "/agenda", label: "Agenda", icon: CalendarDays, reminders: true },
  { to: "/empresas", label: "Empresas", icon: Building2 },
  { to: "/usuarios", label: "Usuários", icon: Users },
  { to: "/equipes-numeros", label: "Equipes e números", icon: UsersRound },
  { to: "/canais", label: "Canais WhatsApp", icon: Smartphone },
  { to: "/automacoes", label: "Automações N8N", icon: Workflow },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/horarios-acesso", label: "Horários de acesso", icon: Clock3, accessHours: true },
  { to: "/configuracoes", label: "Configurações", icon: Settings },
];

export function AppShell() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { user } = useSession();
  const {
    logout,
    companyValid,
    companyName,
    companyId,
    platformAccess,
    setOperationalCompany,
    switchingCompany,
    user: authUser,
  } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const viewportHeight = useMobileViewportHeight();
  const sidebarRef = useRef<HTMLElement>(null);
  const [unread, setUnread] = useState({ atendimento: 0, internal: 0 });
  const [companyOptions, setCompanyOptions] = useState<CompanyOption[]>([]);

  const actor = authUser
    ? actingUserFromAuth({
        id: authUser.id,
        role: authUser.role as string,
        tenantId: authUser.tenantId,
      })
    : null;

  const headerCompanyLabel = companyValid
    ? (companyName ?? "Empresa ativa")
    : platformAccess
      ? "Selecione uma empresa"
      : (companyName ?? authUser?.tenantId ?? "—");

  useEffect(() => subscribeUnread(setUnread), []);

  useEffect(() => {
    if (!platformAccess) return;
    fetch("/api/auth/operational-company", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { companies?: CompanyOption[] } | null) => {
        setCompanyOptions(data?.companies ?? []);
      })
      .catch(() => setCompanyOptions([]));
  }, [platformAccess]);

  useEffect(() => {
    const unlock = () => {
      void unlockNotificationAudio();
    };
    window.addEventListener("pointerdown", unlock, { once: true, passive: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    let cancel = false;
    let inFlight = false;
    const loadUnread = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await fetch("/api/internal-chat/unread-count", { credentials: "include" });
        if (!r.ok) return;
        const j = (await r.json()) as { count?: number };
        if (!cancel) {
          const count = j.count ?? 0;
          onInternalUnreadCountUpdate(count);
          setUnreadStore("internal", count);
        }
      } catch {
        /* ignore */
      } finally {
        inFlight = false;
      }
    };
    loadUnread();
    const id = setInterval(loadUnread, 60_000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = sidebarRef.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select:not([disabled])') ?? [])
      .filter(el => el.getClientRects().length > 0);
    focusable()[0]?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [sidebarOpen]);

  async function onOperationalCompanyChange(nextId: string) {
    if (!nextId) return;
    try {
      await setOperationalCompany(nextId);
      toast.success("Empresa ativa atualizada");
    } catch {
      toast.error("Não foi possível trocar a empresa ativa");
    }
  }

  const onLogout = () => {
    resetInternalUnreadBaseline();
    logout();
    navigate({ to: "/login" });
  };

  return (
    <div data-app-shell className="relative flex h-dvh min-h-0 w-full overflow-hidden bg-background text-foreground" style={{ height: viewportHeight }}>

      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          aria-hidden="true"
        />
      )}

      <aside
        ref={sidebarRef}
        aria-label="Menu principal"
        role={sidebarOpen && viewportHeight !== undefined ? "dialog" : undefined}
        aria-modal={sidebarOpen && viewportHeight !== undefined ? true : undefined}
        inert={!sidebarOpen && viewportHeight !== undefined}
        className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200 lg:relative lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-whatsapp text-whatsapp-foreground font-bold">
            N
          </div>
          <div className="leading-tight min-w-0">
            <div className="text-sm font-semibold">NexaBoot</div>
            <div className="truncate text-xs text-muted-foreground" title={headerCompanyLabel}>
              {headerCompanyLabel}
            </div>
          </div>
          <button type="button" onClick={() => setSidebarOpen(false)} aria-label="Fechar menu" className="ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-md hover:bg-accent lg:hidden">
            <X className="h-5 w-5" />
          </button>
        </div>

        <SidebarNavigation
          pathname={pathname}
          unread={unread}
          onNavigate={() => setSidebarOpen(false)}
          items={nav
            .filter((item) => !item.adminOnly || canManageInternalGroups(user.role))
            .filter((item) => item.to !== "/equipes-numeros" || ["SUPER_ADMIN","TI","ADMIN_GERAL","ADMIN_EMPRESA","GERENTE"].includes(user.role))
            .filter((item) => {
              if (!item.accessHours) return true;
              const role = String(user.role ?? "");
              return ["SUPER_ADMIN", "TI", "ADMIN_GERAL", "ADMIN_EMPRESA"].includes(role);
            })
            .filter((item) => {
              if (!item.flows) return true;
              const role = String(user.role ?? "");
              return ["SUPER_ADMIN", "TI", "ADMIN_GERAL", "ADMIN_EMPRESA"].includes(role);
            })
            .filter((item) => {
              if (!item.reminders) return true;
              const role = String(user.role ?? "");
              return ["SUPER_ADMIN", "TI", "ADMIN_GERAL", "ADMIN_EMPRESA"].includes(role);
            })
            .filter((item) => {
              if (!item.campaignsOnly) return true;
              if (!actor) return false;
              return canAccessCampaignsModule(actor, companyValid);
            })
            .filter((item) => {
              if (!item.waitOnly) return true;
              if (!actor) return false;
              return companyValid && canViewCampaignCosts(actor);
            })
            .filter((item) => {
              if (!item.gerencialOnly) return true;
              if (!actor) return false;
              return companyValid && canViewCampaignCosts(actor);
            })
            .filter(item => item.to !== "/empresas" || platformAccess)
          }
        />

        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-3">
            <div
              className="grid h-9 w-9 place-items-center rounded-full text-sm font-semibold text-white"
              style={{ backgroundColor: user.avatarColor }}
            >
              {user.name
                .split(" ")
                .map((p) => p[0])
                .slice(0, 2)
                .join("")}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium">{user.name}</div>
              <div className="truncate text-xs text-muted-foreground">{roleLabel(user.role)}</div>
            </div>

            <button
              onClick={onLogout}
              className="rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent"
              title="Sair"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
          {platformAccess && companyOptions.length > 0 && (
            <div className="mt-3">
              <label className="mb-1 block text-[10px] uppercase text-muted-foreground">
                Empresa ativa
              </label>
              <select
                disabled={switchingCompany}
                value={companyId ?? ""}
                onChange={(e) => onOperationalCompanyChange(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
              >
                <option value="" disabled>
                  Selecione uma empresa…
                </option>
                {companyOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-2 pt-[env(safe-area-inset-top)] lg:hidden">
          <button type="button" onClick={() => setSidebarOpen(true)} aria-label="Abrir menu" aria-expanded={sidebarOpen} className="grid h-11 w-11 shrink-0 place-items-center rounded-md hover:bg-accent">
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{nav.find(item => pathname === item.to || pathname.startsWith(item.to + "/"))?.label ?? "NexaBoot"}</p>
            <p className="truncate text-xs text-muted-foreground">{headerCompanyLabel}</p>
          </div>
        </header>
        {companyValid && !switchingCompany && <AttendanceAlertBanner companyId={companyId}/>}
        <div className={`min-h-0 min-w-0 flex-1 ${pathname === "/atendimento" || pathname === "/comunicacao-interna" ? "overflow-hidden" : "overflow-auto"}`}>
        {switchingCompany ? (
          <div role="status" className="grid h-full place-items-center p-6 text-sm">
            Alterando empresa…
          </div>
        ) : isOperationalPath(pathname) && !companyValid ? (
          <div className="grid h-full place-items-center p-6">
            <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm">
              <h1 className="text-lg font-semibold text-foreground">Empresa necessária</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {platformAccess
                  ? "Selecione uma empresa ativa no menu lateral para acessar este módulo."
                  : "Seu usuário não está vinculado a uma empresa válida. Contate o administrador."}
              </p>
            </div>
          </div>
        ) : (
          <Outlet />
        )}
        </div>
      </main>


    </div>
  );
}
