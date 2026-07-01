// Autenticação real do NexaBoot via PostgreSQL.
// Backend: /api/auth/login, /api/auth/me, /api/auth/me?action=logout
// Sessão: cookie httpOnly assinado (ver src/lib/session.server.ts).
// Mantém a mesma interface do useAuth para não quebrar a tela de login.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { tenants, type Role, type User, type Tenant } from "./mocks";
import { pushAudit } from "./audit-log";

interface DbUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenant_id: string;
  company_id?: string | null;
  company_name?: string | null;
  company_valid?: boolean;
  platform_access?: boolean;
}

/** Perfis de plataforma: podem entrar sem empresa (módulos operacionais ainda exigem empresa). */
function isPlatformRoleName(role?: string | null): boolean {
  const r = String(role ?? "").toUpperCase();
  return r === "SUPER_ADMIN" || r === "TI";
}

function toUser(u: DbUser): User {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: (u.role as Role) ?? "ATENDENTE",
    tenantId: u.tenant_id ?? "default",
    avatarColor: "#00a884",
  };
}

interface AuthContextValue {
  user: User | null;
  tenant: Tenant | null;
  isAuthenticated: boolean;
  hydrated: boolean;
  /** Isolamento oficial por company_id: false bloqueia módulos operacionais. */
  companyValid: boolean;
  companyName: string | null;
  companyMessage: string | null;
  /** SUPER_ADMIN/TI: entram sem empresa, mas módulos operacionais ainda exigem empresa. */
  platformAccess: boolean;
  /** company_id do usuário logado (quando válido). */
  companyId: string | null;
  attempts: number;
  lockedUntil: number | null;
  login: (email: string, password: string, remember: boolean) => Promise<LoginResult>;
  logout: () => void;
  requestPasswordReset: (email: string) => Promise<void>;
}

const NO_COMPANY_MESSAGE =
  "Seu usuário não está vinculado a uma empresa. Contate o administrador.";

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "blocked" | "locked"; message: string; waitSeconds?: number };

const AuthContext = createContext<AuthContextValue | null>(null);

const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 30;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [companyValid, setCompanyValid] = useState(true);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [companyMessage, setCompanyMessage] = useState<string | null>(null);
  const [platformAccess, setPlatformAccess] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);

  // Hidratação: pergunta ao backend quem está logado pelo cookie.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error("me failed");
        const data = (await res.json()) as {
          user: DbUser | null;
          company_message?: string;
        };
        if (!cancelled && data.user) {
          setUser(toUser(data.user));
          const valid = data.user.company_valid !== false;
          const platform = data.user.platform_access ?? isPlatformRoleName(data.user.role);
          setCompanyValid(valid);
          setCompanyName(data.user.company_name ?? null);
          setCompanyId(data.user.company_id ?? null);
          setPlatformAccess(platform);
          setCompanyMessage(valid ? null : data.company_message ?? NO_COMPANY_MESSAGE);
        }
      } catch {
        /* sem sessão */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (email: string, password: string, _remember: boolean): Promise<LoginResult> => {
      const now = Date.now();
      if (lockedUntil && lockedUntil > now) {
        const waitSeconds = Math.ceil((lockedUntil - now) / 1000);
        return {
          ok: false,
          reason: "locked",
          message: `Muitas tentativas. Tente novamente em ${waitSeconds}s.`,
          waitSeconds,
        };
      }

      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
        });

        const data = (await res.json().catch(() => ({}))) as {
          user?: DbUser;
          error?: string;
          reason?: string;
          message?: string;
        };

        if (!res.ok) {
          const code = data?.error ?? "unknown_error";

          // Usuário sem empresa válida: bloqueio claro, NÃO conta como tentativa
          // de senha (credenciais estavam corretas) e não dispara lockout.
          if (code === "no_company") {
            pushAudit({
              tenantId: null,
              actorId: "anonymous",
              actorName: email,
              action: "auth.login.blocked_no_company",
              targetType: "auth",
              targetId: email,
              result: "denied",
              reason: "Login bloqueado: usuário sem empresa vinculada.",
            });
            return {
              ok: false,
              reason: "blocked",
              message:
                data?.message ??
                "Usuário sem empresa vinculada. Contate o administrador.",
            };
          }

          // Erros de infraestrutura não devem contar como tentativa nem bloquear.
          const isInfra = code === "db_connection_error" || code === "session_not_created";

          pushAudit({
            tenantId: null,
            actorId: "anonymous",
            actorName: email,
            action: "auth.login.failed",
            targetType: "auth",
            targetId: email,
            result: "denied",
            reason: `Login falhou: ${code}${data?.reason ? ` (${data.reason})` : ""}`,
          });

          // Mensagens diferenciadas para diagnóstico.
          const DIAG_MESSAGES: Record<string, string> = {
            user_not_found: "Usuário não encontrado.",
            invalid_password: "Senha inválida.",
            user_inactive: "Usuário inativo. Procure o administrador.",
            tenant_invalid: "Tenant inválido para este usuário.",
            db_connection_error: "Erro de conexão com o banco de dados.",
            session_not_created: "Falha ao criar a sessão. Verifique SESSION_SECRET.",
            invalid_input: "Dados de login inválidos.",
          };
          const message = DIAG_MESSAGES[code] ?? "E-mail ou senha inválidos.";

          if (isInfra) {
            return { ok: false, reason: "invalid", message };
          }

          const next = attempts + 1;
          setAttempts(next);
          if (next >= MAX_ATTEMPTS) {
            const until = Date.now() + LOCK_SECONDS * 1000;
            setLockedUntil(until);
            return {
              ok: false,
              reason: "locked",
              message: `Acesso temporariamente bloqueado por segurança (${LOCK_SECONDS}s).`,
              waitSeconds: LOCK_SECONDS,
            };
          }

          return {
            ok: false,
            reason: code === "user_inactive" ? "blocked" : "invalid",
            message,
          };
        }

        if (!data.user) {
          return {
            ok: false,
            reason: "invalid",
            message: "Resposta de login inválida do servidor.",
          };
        }
        const u = toUser(data.user);
        setUser(u);
        const valid = data.user.company_valid !== false;
        const platform = data.user.platform_access ?? isPlatformRoleName(data.user.role);
        setCompanyValid(valid);
        setCompanyName(data.user.company_name ?? null);
        setCompanyId(data.user.company_id ?? null);
        setPlatformAccess(platform);
        setCompanyMessage(valid ? null : NO_COMPANY_MESSAGE);
        setAttempts(0);
        setLockedUntil(null);
        pushAudit({
          tenantId: u.tenantId,
          actorId: u.id,
          actorName: u.name,
          action: "auth.login.success",
          targetType: "user",
          targetId: u.id,
          result: "success",
          reason: `Login: ${u.email}`,
        });
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          reason: "invalid",
          message: "Falha de conexão. Tente novamente.",
        };
      }
    },
    [attempts, lockedUntil],
  );

  const logout = useCallback(() => {
    const current = user;
    setUser(null);
    setCompanyValid(true);
    setCompanyName(null);
    setCompanyId(null);
    setCompanyMessage(null);
    setPlatformAccess(false);
    fetch("/api/auth/me?action=logout", {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    if (current) {
      pushAudit({
        tenantId: current.tenantId,
        actorId: current.id,
        actorName: current.name,
        action: "auth.logout",
        targetType: "user",
        targetId: current.id,
        result: "success",
        reason: `Logout: ${current.email}`,
      });
    }
  }, [user]);

  const requestPasswordReset = useCallback(async (email: string) => {
    await new Promise((r) => setTimeout(r, 400));
    pushAudit({
      tenantId: null,
      actorId: "anonymous",
      actorName: email,
      action: "auth.password.reset_requested",
      targetType: "auth",
      targetId: email,
      result: "success",
      reason: `Recuperação solicitada para ${email}`,
    });
  }, []);

  const tenant = useMemo(
    () =>
      user
        ? tenants.find((t) => t.id === user.tenantId) ?? {
            id: user.tenantId,
            name: user.tenantId,
            cnpj: "",
            plan: "Free" as const,
            status: "ativo" as const,
            sharedAttendance: false,
          }
        : null,
    [user],
  );

  const value: AuthContextValue = {
    user,
    tenant,
    isAuthenticated: !!user,
    hydrated,
    companyValid,
    companyName,
    companyMessage,
    platformAccess,
    companyId,
    attempts,
    lockedUntil,
    login,
    logout,
    requestPasswordReset,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de <AuthProvider>");
  return ctx;
}
