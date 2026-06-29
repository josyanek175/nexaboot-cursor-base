import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard, MessagesSquare, Users, Building2, Smartphone,
  Workflow, MessageCircleMore, Contact2, Settings, ScrollText, LogOut,
  UserCog, Menu, UsersRound,
} from "lucide-react";
import { canManageInternalGroups } from "@/lib/current-user";
import { useEffect, useState } from "react";
import { users, tenants, type Role } from "@/lib/mocks";
import { subscribeUnread, setUnread as setUnreadStore, type UnreadKey } from "@/lib/unread-store";
import { SessionProvider, useSession } from "@/lib/session";
import { useAuth } from "@/lib/auth";

const ROLE_LABELS: Record<Role, string> = {
  ADMIN_GERAL: "Super-Admin (plataforma)",
  TI: "TI · Plataforma",
  ADMIN_EMPRESA: "Admin Empresa",
  GERENTE: "Gerente",
  SUPERVISOR: "Supervisor",
  ATENDENTE_GERAL: "Atendente Geral",
  ATENDENTE: "Atendente",
};
const roleLabel = (r: Role) => ROLE_LABELS[r] ?? r;

// Módulos OPERACIONAIS (dados de empresa). Sem company_id válido, SUPER_ADMIN/TI
// veem "Selecione uma empresa..." em vez do conteúdo, evitando dados misturados.
const OPERATIONAL_PREFIXES = ["/atendimento", "/contatos", "/canais"];
function isOperationalPath(pathname: string): boolean {
  return OPERATIONAL_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  badgeKey?: UnreadKey;
  adminOnly?: boolean;
};

const nav: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/atendimento", label: "Atendimento", icon: MessagesSquare, badgeKey: "atendimento" as UnreadKey },
  { to: "/comunicacao-interna", label: "Comunicação Interna", icon: MessageCircleMore, badgeKey: "internal" as UnreadKey },
  { to: "/grupos-internos", label: "Grupos Internos", icon: UsersRound, adminOnly: true },
  { to: "/contatos", label: "Contatos", icon: Contact2 },
  { to: "/empresas", label: "Empresas", icon: Building2 },
  { to: "/usuarios", label: "Usuários", icon: Users },
  { to: "/canais", label: "Canais WhatsApp", icon: Smartphone },
  { to: "/automacoes", label: "Automações N8N", icon: Workflow },
  { to: "/logs", label: "Logs", icon: ScrollText },
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
  const { user, tenant, isSuperAdmin, visibleTenants, setUserId, setTenantId } = useSession();
  const { logout, companyValid } = useAuth();
  const navigate = useNavigate();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unread, setUnread] = useState({ atendimento: 0, internal: 0 });

  useEffect(() => subscribeUnread(setUnread), []);

  // Polling global do contador de Comunicação Interna não lida (a cada 10s).
  // Mantém o badge do menu atualizado em qualquer página do sistema.
  useEffect(() => {
    let cancel = false;
    const loadUnread = async () => {
      try {
        const r = await fetch("/api/internal-chat/unread-count", { credentials: "include" });
        if (!r.ok) return;
        const j = (await r.json()) as { count?: number };
        if (!cancel) setUnreadStore("internal", j.count ?? 0);
      } catch {
        /* offline/sem sessão — ignora */
      }
    };
    loadUnread();
    const id = setInterval(loadUnread, 10000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, []);

  // Fecha sidebar mobile automaticamente ao navegar entre páginas
  useEffect(() => { setSidebarOpen(false); }, [pathname]);

  const onLogout = () => {
    logout();
    navigate({ to: "/login" });
  };

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Botão hamburger flutuante (apenas mobile/tablet) */}
      <button
        onClick={() => setSidebarOpen(true)}
        className={`fixed top-2 left-2 z-30 grid h-9 w-9 place-items-center rounded-md border border-border bg-card/90 backdrop-blur shadow-sm text-foreground lg:hidden ${sidebarOpen ? "hidden" : ""}`}
        aria-label="Abrir menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Backdrop mobile */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200 lg:relative lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-whatsapp text-whatsapp-foreground font-bold">N</div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">NexaBoot</div>
            <div className="truncate text-xs text-muted-foreground">{tenant.name}</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          {nav
            .filter((item) => !item.adminOnly || canManageInternalGroups(user.role))
            .map((item) => {
              const { to, label, icon: Icon, badgeKey } = item;
              const count = badgeKey ? unread[badgeKey] : 0;
              const active = pathname === to || pathname.startsWith(to + "/");
              return (
                <Link
                  key={to}
                  to={to}
                  className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex-1 truncate">{label}</span>
                  {count > 0 && (
                    <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </Link>
              );
            })}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-3">
            <div
              className="grid h-9 w-9 place-items-center rounded-full text-sm font-semibold text-white"
              style={{ backgroundColor: user.avatarColor }}
            >
              {user.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium">{user.name}</div>
              <div className="truncate text-xs text-muted-foreground">{roleLabel(user.role)}</div>
            </div>
            <button
              onClick={() => setSwitcherOpen(true)}
              className="rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent"
              title="Trocar perfil (somente para testes)"
            >
              <UserCog className="h-4 w-4" />
            </button>
            <button
              onClick={onLogout}
              className="rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent"
              title="Sair"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
          {isSuperAdmin && visibleTenants.length > 1 && (
            <div className="mt-3">
              <label className="mb-1 block text-[10px] uppercase text-muted-foreground">Empresa ativa (super-admin)</label>
              <select
                value={tenant.id}
                onChange={(e) => setTenantId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
              >
                {visibleTenants.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-hidden">
        {isOperationalPath(pathname) && !companyValid ? (
          <div className="grid h-full place-items-center p-6">
            <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm">
              <h1 className="text-lg font-semibold text-foreground">Empresa necessária</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Selecione uma empresa para acessar este módulo.
              </p>
            </div>
          </div>
        ) : (
          <Outlet />
        )}
      </main>

      {switcherOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setSwitcherOpen(false)}>
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">Trocar perfil de teste</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Útil para validar isolamento multitenant. Em produção será substituído por Supabase Auth.
            </p>
            <div className="mt-4 max-h-80 space-y-1 overflow-y-auto">
              {users.map((u) => {
                const t = tenants.find((x) => x.id === u.tenantId);
                const active = u.id === user.id;
                return (
                  <button
                    key={u.id}
                    onClick={() => {
                      setUserId(u.id);
                      setSwitcherOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                      active ? "border-whatsapp bg-whatsapp/10" : "border-border hover:bg-accent"
                    }`}
                  >
                    <div
                      className="grid h-8 w-8 place-items-center rounded-full text-xs font-semibold text-white"
                      style={{ backgroundColor: u.avatarColor }}
                    >
                      {u.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{u.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{roleLabel(u.role)} · {t?.name}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
