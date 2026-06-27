// Cadastro inteligente:
// - Se nenhum usuário existe no banco → modo "bootstrap": cria o primeiro ADMIN e loga.
// - Se já existe admin logado → permite criar outros usuários (USER ou ADMIN).
// - Caso contrário → bloqueia e pede login como admin.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/register")({
  component: RegisterPage,
});

type Mode = "loading" | "bootstrap" | "admin" | "forbidden";
type Me = { id: string; name: string; email: string; role: string; tenant_id: string | null };
type CreatedUser = { id: string; name: string; email: string; tenant_id: string; role: string; created_at?: string };
type DbInfo = { database: string | null; user: string | null; schema: string | null; usersCount: number };
type DbUser = { id: string; tenant_id: string; name: string; email: string; role: string; created_at: string };

function RegisterPage() {
  
  const [mode, setMode] = useState<Mode>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantId, setTenantId] = useState("default");
  const [role, setRole] = useState<"USER" | "ADMIN">("USER");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedUser | null>(null);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [dbUsers, setDbUsers] = useState<DbUser[] | null>(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  useEffect(() => {
    void refreshMode();
  }, []);

  async function refreshMode() {
    try {
      const r = await fetch("/api/auth/register", { credentials: "include" });
      const j = (await r.json()) as { mode?: Mode; me?: Me };
      setMode(j.mode ?? "forbidden");
      setMe(j.me ?? null);
      if (j.me?.tenant_id) setTenantId(j.me.tenant_id);
    } catch {
      setMode("forbidden");
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOkMsg(null);
    setCreated(null);
    setDbInfo(null);
    setLoading(true);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          tenantId,
          role: mode === "bootstrap" ? "ADMIN" : role,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        detail?: unknown;
        bootstrap?: boolean;
        user?: CreatedUser;
        db?: DbInfo;
      };
      if (!r.ok || !j.success) {
        const detailMsg =
          typeof j.detail === "string"
            ? j.detail
            : j.detail
              ? JSON.stringify(j.detail)
              : "";
        throw new Error((j.error ?? `HTTP ${r.status}`) + (detailMsg ? ` — ${detailMsg}` : ""));
      }
      if (!j.user) {
        throw new Error("INSERT não retornou usuário — não há evidência de gravação");
      }
      setCreated(j.user);
      setDbInfo(j.db ?? null);
      setOkMsg("Usuário salvo no PostgreSQL");
      setName("");
      setEmail("");
      setPassword("");
      setRole("USER");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadDbUsers() {
    setDbError(null);
    setDbLoading(true);
    try {
      const r = await fetch("/api/debug/db", { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setDbUsers(j.latestUsers ?? []);
      if (j.current) {
        setDbInfo({
          database: j.current.db,
          user: j.current.usr,
          schema: j.current.schema,
          usersCount: j.counts?.users ?? 0,
        });
      }
    } catch (e) {
      setDbError((e as Error).message);
    } finally {
      setDbLoading(false);
    }
  }

  if (mode === "loading") {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (mode === "forbidden") {
    return (
      <div className="grid min-h-screen place-items-center bg-background p-6">
        <div className="max-w-sm rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <ShieldAlert className="mx-auto mb-2 h-8 w-8 text-destructive" />
          <h1 className="text-base font-semibold">Acesso restrito</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Apenas administradores podem criar novos usuários.
          </p>
          <Link to="/login" className="mt-4 inline-block text-sm underline">
            Entrar como administrador
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6"
      >
        <div>
          <h1 className="text-lg font-semibold">
            {mode === "bootstrap" ? "Criar administrador inicial" : "Criar novo usuário"}
          </h1>
          <p className="text-xs text-muted-foreground">
            {mode === "bootstrap"
              ? "Nenhum usuário cadastrado. Este será o primeiro ADMIN do sistema."
              : `Logado como ${me?.name} (${me?.role}). Apenas ADMIN pode criar usuários.`}
          </p>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {okMsg && (
          <div className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700">
            {okMsg}
          </div>
        )}
        {created && (
          <div className="space-y-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-800">
            <div className="font-semibold">Usuário salvo no PostgreSQL</div>
            <div><span className="opacity-70">ID:</span> <span className="font-mono">{created.id}</span></div>
            <div><span className="opacity-70">Email:</span> {created.email}</div>
            <div><span className="opacity-70">Tenant:</span> {created.tenant_id}</div>
            <div><span className="opacity-70">Role:</span> {created.role}</div>
            {dbInfo && (
              <div className="mt-2 border-t border-emerald-500/20 pt-2">
                <div><span className="opacity-70">current_database():</span> {dbInfo.database}</div>
                <div><span className="opacity-70">current_user:</span> {dbInfo.user}</div>
                <div><span className="opacity-70">current_schema():</span> {dbInfo.schema}</div>
                <div><span className="opacity-70">COUNT(*) public.users:</span> {dbInfo.usersCount}</div>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={loadDbUsers}
            disabled={dbLoading}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {dbLoading && <Loader2 className="h-3 w-3 animate-spin" />}
            Ver usuários do banco
          </button>
          {dbError && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {dbError}
            </div>
          )}
          {dbUsers && (
            <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
              <div className="font-semibold">
                Últimos {dbUsers.length} usuários em public.users
              </div>
              {dbUsers.length === 0 && <div className="opacity-70">Nenhum usuário encontrado.</div>}
              {dbUsers.map((u) => (
                <div key={u.id} className="font-mono">
                  {u.email} · {u.tenant_id} · {u.role}
                </div>
              ))}
              {created && !dbUsers.some((u) => u.id === created.id) && (
                <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-destructive">
                  ⚠ O usuário criado ({created.id}) NÃO aparece nesta lista.
                  O INSERT pode estar indo para outro banco.
                </div>
              )}
            </div>
          )}
        </div>

        <input
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder="Nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          type="email"
          placeholder="E-mail"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          type="password"
          placeholder="Senha (mín. 6)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
        />
        <input
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder="Tenant ID"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
        />
        {mode === "admin" && (
          <select
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={role}
            onChange={(e) => setRole(e.target.value as "USER" | "ADMIN")}
          >
            <option value="USER">USER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        )}

        <button
          type="submit"
          disabled={loading}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {mode === "bootstrap" ? "Criar admin e entrar" : "Criar usuário"}
        </button>

        <div className="text-center text-xs text-muted-foreground">
          {mode === "bootstrap" ? (
            <>
              Já tem conta? <Link to="/login" className="underline">Entrar</Link>
            </>
          ) : (
            <Link to="/comunicacao-interna" className="underline">
              Voltar para Comunicação Interna
            </Link>
          )}
        </div>
      </form>
    </div>
  );
}
