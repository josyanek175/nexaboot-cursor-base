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
  attempts: number;
  lockedUntil: number | null;
  login: (email: string, password: string, remember: boolean) => Promise<LoginResult>;
  logout: () => void;
  requestPasswordReset: (email: string) => Promise<void>;
}

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
        const data = (await res.json()) as { user: DbUser | null };
        if (!cancelled && data.user) setUser(toUser(data.user));
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

        if (!res.ok) {
          const next = attempts + 1;
          setAttempts(next);
          pushAudit({
            tenantId: null,
            actorId: "anonymous",
            actorName: email,
            action: "auth.login.failed",
            targetType: "auth",
            targetId: email,
            result: "denied",
            reason: `Login inválido (${next}/${MAX_ATTEMPTS})`,
          });
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
            reason: "invalid",
            message: "E-mail ou senha inválidos.",
          };
        }

        const data = (await res.json()) as { user: DbUser };
        const u = toUser(data.user);
        setUser(u);
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
