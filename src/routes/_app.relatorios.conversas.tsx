import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FileBarChart2,
  Loader2,
  Download,
  Search,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  canAccessConversationReportsModule,
  actingUserFromAuth,
} from "@/lib/permissions";
import { formatCsvDateTime } from "@/lib/csv-safe";

export const Route = createFileRoute("/_app/relatorios/conversas")({
  component: ConversationReportsPage,
  head: () => ({ meta: [{ title: "Relatório de Conversas — NexaBoot" }] }),
});

type ReportRow = {
  id: string;
  created_at: string;
  contact_name: string | null;
  phone: string | null;
  channel_name: string | null;
  attendance_status: string;
  attendance_status_label?: string;
  message_origin: "Cliente" | "Atendente" | "Sistema";
  message_display: string;
  assigned_attendant_name: string | null;
  sender_name: string | null;
  displayed_attendant_name: string | null;
};

type AttendantOpt = { id: string; name: string };
type ChannelOpt = { id: string; name: string };

type Cursor = { createdAt: string; id: string };

function defaultDates(): { from: string; to: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const now = new Date();
  const from = new Date(now.getTime() - 6 * 86400000);
  return { from: fmt.format(from), to: fmt.format(now) };
}

function statusLabel(status: string, apiLabel?: string): string {
  if (apiLabel) return apiLabel;
  const map: Record<string, string> = {
    open: "Aberta",
    waiting: "Aguardando",
    finished: "Finalizada",
    archived: "Arquivada",
  };
  return map[status] ?? status;
}

function buildQuery(params: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") sp.set(k, v);
  }
  return sp.toString();
}

function ConversationReportsPage() {
  const { user, companyValid, companyId, companyMessage } = useAuth();
  const actor = user
    ? actingUserFromAuth({
        id: user.id,
        role: user.role as string,
        tenantId: user.tenantId,
      })
    : { id: "", role: "ATENDENTE" as const, tenantId: "" };

  const canAccess = canAccessConversationReportsModule(actor, companyValid);
  const defaults = useMemo(() => defaultDates(), []);

  const [dateFrom, setDateFrom] = useState(defaults.from);
  const [dateTo, setDateTo] = useState(defaults.to);
  const [attendantUserId, setAttendantUserId] = useState("");
  const [search, setSearch] = useState("");
  const [channelId, setChannelId] = useState("");
  const [status, setStatus] = useState("all");
  const [origin, setOrigin] = useState("all");
  const [includeSystem, setIncludeSystem] = useState(false);

  const [applied, setApplied] = useState(() => ({
    dateFrom: defaults.from,
    dateTo: defaults.to,
    attendantUserId: "",
    search: "",
    channelId: "",
    status: "all",
    origin: "all",
    includeSystem: false,
  }));

  const [rows, setRows] = useState<ReportRow[]>([]);
  const [nextCursor, setNextCursor] = useState<Cursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attendants, setAttendants] = useState<AttendantOpt[]>([]);
  const [channels, setChannels] = useState<ChannelOpt[]>([]);

  const filterParams = useCallback(
    (cursor?: Cursor | null, extras?: Record<string, string>) =>
      buildQuery({
        date_from: applied.dateFrom,
        date_to: applied.dateTo,
        attendant_user_id: applied.attendantUserId || null,
        search: applied.search || null,
        channel_id: applied.channelId || null,
        status: applied.status !== "all" ? applied.status : null,
        origin: applied.origin !== "all" ? applied.origin : null,
        include_system: applied.includeSystem ? "true" : "false",
        cursor_created_at: cursor?.createdAt ?? null,
        cursor_id: cursor?.id ?? null,
        ...extras,
      }),
    [applied],
  );

  const loadPage = useCallback(
    async (mode: "replace" | "append", cursor: Cursor | null) => {
      if (!canAccess) return;
      if (mode === "replace") {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      try {
        const qs = filterParams(cursor, {
          include_meta: mode === "replace" ? "true" : "false",
          include_total: mode === "replace" ? "true" : "false",
          limit: "50",
        });
        const res = await fetch(`/api/reports/conversations?${qs}`, {
          credentials: "include",
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
          rows?: ReportRow[];
          next_cursor?: Cursor | null;
          has_more?: boolean;
          total?: number;
          meta?: { channels?: ChannelOpt[] };
        };
        if (res.status === 401) {
          setError("Sessão expirada. Faça login novamente.");
          setRows([]);
          return;
        }
        if (res.status === 403) {
          setError(body.message ?? "Sem permissão para acessar o relatório.");
          setRows([]);
          return;
        }
        if (!res.ok) {
          setError(body.message ?? body.error ?? `Erro HTTP ${res.status}`);
          if (mode === "replace") setRows([]);
          return;
        }
        const nextRows = body.rows ?? [];
        setRows((prev) => (mode === "append" ? [...prev, ...nextRows] : nextRows));
        setNextCursor(body.next_cursor ?? null);
        setHasMore(Boolean(body.has_more));
        if (mode === "replace" && typeof body.total === "number") setTotal(body.total);
        if (body.meta?.channels) setChannels(body.meta.channels);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Falha ao carregar o relatório.");
        if (mode === "replace") setRows([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [canAccess, filterParams],
  );

  useEffect(() => {
    if (!canAccess) {
      setLoading(false);
      setError(
        companyMessage ??
          (companyValid
            ? "Seu perfil não tem permissão para acessar o relatório de conversas."
            : "Selecione uma empresa ativa."),
      );
      return;
    }
    void loadPage("replace", null);
  }, [canAccess, companyValid, companyId, companyMessage, loadPage]);

  useEffect(() => {
    if (!canAccess) return;
    fetch("/api/attendants", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { attendants?: AttendantOpt[] } | null) => {
        setAttendants(data?.attendants ?? []);
      })
      .catch(() => setAttendants([]));
  }, [canAccess, companyId]);

  function applyFilters(e?: { preventDefault(): void }) {
    e?.preventDefault();
    setApplied({
      dateFrom,
      dateTo,
      attendantUserId,
      search: search.trim(),
      channelId,
      status,
      origin,
      includeSystem,
    });
  }

  async function handleExport() {
    if (!canAccess || exporting) return;
    setExporting(true);
    try {
      const qs = filterParams(null);
      const res = await fetch(`/api/reports/conversations/export.csv?${qs}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i.exec(cd);
      const filename = decodeURIComponent(match?.[1] || match?.[2] || `conversas-${applied.dateFrom}-${applied.dateTo}.csv`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("CSV baixado");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao exportar CSV");
    } finally {
      setExporting(false);
    }
  }

  if (!canAccess) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm">
          <AlertTriangle className="mx-auto h-8 w-8 text-amber-600" />
          <h1 className="mt-3 text-lg font-semibold">Acesso restrito</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {error ??
              "O relatório de conversas está disponível apenas para Admin Empresa e Gerente."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <FileBarChart2 className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Relatório de Conversas</h1>
            <p className="text-xs text-muted-foreground">
              Auditoria de mensagens da empresa · máx. 90 dias por consulta
              {total != null ? ` · ${total.toLocaleString("pt-BR")} mensagem(ns)` : ""}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exporting || loading}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Exportar CSV
        </button>
      </header>

      <form
        onSubmit={applyFilters}
        className="grid gap-2 border-b border-border bg-muted/30 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 sm:px-6"
      >
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Data inicial</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            required
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Data final</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            required
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Atendente</span>
          <select
            value={attendantUserId}
            onChange={(e) => setAttendantUserId(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Todos</option>
            {attendants.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs sm:col-span-2 lg:col-span-1">
          <span className="mb-1 block text-muted-foreground">Cliente ou telefone</span>
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nome ou telefone"
              className="h-9 w-full rounded-md border border-input bg-background py-1 pr-2 pl-7 text-sm"
            />
          </div>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Canal</span>
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Todos</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="all">Todos</option>
            <option value="open">Aberta</option>
            <option value="waiting">Aguardando</option>
            <option value="finished">Finalizada</option>
            <option value="archived">Arquivada</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Origem</span>
          <select
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="all">Todas</option>
            <option value="client">Cliente</option>
            <option value="attendant">Atendente</option>
          </select>
        </label>
        <label className="flex items-end gap-2 pb-1 text-xs sm:col-span-2">
          <input
            type="checkbox"
            checked={includeSystem}
            onChange={(e) => setIncludeSystem(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          <span>Incluir mensagens do sistema</span>
        </label>
        <div className="flex items-end sm:col-span-2 lg:col-span-1">
          <button
            type="submit"
            className="inline-flex h-9 w-full items-center justify-center rounded-md border border-border bg-card px-3 text-sm font-medium hover:bg-accent"
          >
            Filtrar
          </button>
        </div>
      </form>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Carregando relatório…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center text-sm text-destructive">
            {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Nenhuma mensagem encontrada para os filtros selecionados.
          </div>
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Cliente</th>
                    <th className="px-3 py-2 text-left">Telefone</th>
                    <th className="px-3 py-2 text-left">Atendente</th>
                    <th className="px-3 py-2 text-left">Canal</th>
                    <th className="px-3 py-2 text-left">Origem</th>
                    <th className="px-3 py-2 text-left">Mensagem</th>
                    <th className="px-3 py-2 text-left">Data e hora</th>
                    <th className="px-3 py-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-border align-top hover:bg-muted/20">
                      <td className="px-3 py-2 whitespace-nowrap">{r.contact_name || "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                        {r.phone || "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div>{r.displayed_attendant_name || "—"}</div>
                        {r.sender_name &&
                          r.assigned_attendant_name &&
                          r.sender_name !== r.assigned_attendant_name && (
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              Enviado por: {r.sender_name}
                            </div>
                          )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.channel_name || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.message_origin}</td>
                      <td className="max-w-xs px-3 py-2">
                        <div className="whitespace-pre-wrap break-words text-xs">
                          {r.message_display || "—"}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                        {formatCsvDateTime(r.created_at)}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        {statusLabel(r.attendance_status, r.attendance_status_label)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {hasMore && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadPage("append", nextCursor)}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-4 text-sm hover:bg-accent disabled:opacity-50"
                >
                  {loadingMore ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  Carregar mais
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
