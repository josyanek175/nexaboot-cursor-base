import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import {
  LayoutDashboard,
  MessagesSquare,
  CalendarDays,
  Megaphone,
  UsersRound,
  Settings,
  Building2,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { navigationAreas, navigationAreaForPath } from "@/lib/navigation-areas";
import type { UnreadKey } from "@/lib/unread-store";

type Item = { to: string; label: string; icon: LucideIcon; badgeKey?: UnreadKey };
type Props = {
  items: Item[];
  pathname: string;
  unread: Record<UnreadKey, number>;
  onNavigate: () => void;
};
const icons = {
  overview: LayoutDashboard,
  attendance: MessagesSquare,
  agenda: CalendarDays,
  marketing: Megaphone,
  team: UsersRound,
  settings: Settings,
  platform: Building2,
};
export function SidebarNavigation({ items, pathname, unread, onNavigate }: Props) {
  const [open, setOpen] = useState<string | null>(() => navigationAreaForPath(pathname) ?? null);
  const id = useId();
  useEffect(() => setOpen(navigationAreaForPath(pathname) ?? null), [pathname]);
  const active = (to: string) => pathname === to || pathname.startsWith(to + "/");
  function badge(count: number) {
    return count > 0 ? (
      <span
        aria-label={`${count} não lidas`}
        className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground"
      >
        {count > 99 ? "99+" : count}
      </span>
    ) : null;
  }
  function renderArea(area: (typeof navigationAreas)[number]) {
    const children = area.paths.flatMap((path) => items.filter((item) => item.to === path));
    if (!children.length) return null;
    const Icon = icons[area.id];
    const selected = children.some((item) => active(item.to));
    const count = children.reduce(
      (sum, item) => sum + (item.badgeKey ? unread[item.badgeKey] : 0),
      0,
    );
    const expanded = open === area.id;
    const classes = `flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${selected ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground hover:bg-sidebar-accent/60"}`;
    if (area.id === "agenda" || area.id === "platform")
      return (
        <Link
          key={area.id}
          to={children[0].to}
          aria-current={selected ? "page" : undefined}
          onClick={onNavigate}
          className={classes}
        >
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="flex-1">{area.id === "platform" ? "Empresas" : area.label}</span>
        </Link>
      );
    return (
      <div key={area.id}>
        <button
          type="button"
          className={classes}
          aria-expanded={expanded}
          aria-controls={`${id}-${area.id}`}
          onClick={() => setOpen(expanded ? null : area.id)}
        >
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 leading-snug">{area.label}</span>
          {!expanded && badge(count)}
          <ChevronDown
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        <div id={`${id}-${area.id}`} hidden={!expanded}>
          <ul
            aria-label={area.label}
            className="ml-5 mt-1 space-y-1 border-l border-sidebar-border pl-2"
          >
            {children.map((item) => {
              const ChildIcon = item.icon;
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    onClick={onNavigate}
                    aria-current={active(item.to) ? "page" : undefined}
                    className={`flex min-h-11 items-center gap-2 rounded-lg px-2 py-2 text-sm ${active(item.to) ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60"}`}
                  >
                    <ChildIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">
                      {item.to === "/configuracoes" ? "Preferências da empresa" : item.label}
                    </span>
                    {item.badgeKey && badge(unread[item.badgeKey])}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label="Áreas de trabalho" className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {navigationAreas.filter((a) => a.id !== "settings" && a.id !== "platform").map(renderArea)}
      </nav>
      <nav
        aria-label="Administração e configurações"
        className="max-h-[45dvh] shrink-0 space-y-1 overflow-y-auto border-t border-sidebar-border p-2"
      >
        {navigationAreas.filter((a) => a.id === "settings" || a.id === "platform").map(renderArea)}
      </nav>
    </div>
  );
}
