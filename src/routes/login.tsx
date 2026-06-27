import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { MessageCircle, Lock, Mail, ShieldCheck, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  head: () => ({
    meta: [
      { title: "Entrar — NexaBoot" },
      { name: "description", content: "Acesse a plataforma NexaBoot de atendimento multicanal." },
    ],
  }),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function LoginPage() {
  const navigate = useNavigate();
  const { isAuthenticated, hydrated, login, attempts, lockedUntil } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Timer para atualizar contador do lockout.
  useEffect(() => {
    if (!lockedUntil) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  if (hydrated && isAuthenticated) {
    return <Navigate to="/atendimento" />;
  }

  const locked = !!(lockedUntil && lockedUntil > now);
  const lockSeconds = locked && lockedUntil ? Math.ceil((lockedUntil - now) / 1000) : 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!EMAIL_RE.test(email.trim())) {
      setError("Informe um e-mail válido.");
      return;
    }
    if (password.length < 4) {
      setError("Informe sua senha.");
      return;
    }

    setSubmitting(true);
    const res = await login(email, password, remember);
    setSubmitting(false);

    if (res.ok) {
      toast.success("Bem-vindo de volta!");
      navigate({ to: "/atendimento" });
      return;
    }
    setError(res.message);
    if (res.reason === "blocked") {
      toast.error("Acesso bloqueado. Procure o administrador.");
    }
  }

  return (
    <div className="grid min-h-screen w-full grid-cols-1 bg-background lg:grid-cols-2">
      {/* Painel ilustrativo */}
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-whatsapp via-whatsapp/90 to-emerald-700 p-10 text-whatsapp-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-white/15 backdrop-blur">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div>
            <div className="text-lg font-semibold">NexaBoot</div>
            <div className="text-xs opacity-80">Atendimento multicanal SaaS</div>
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-3xl font-semibold leading-tight">
            Atenda mais rápido,<br />em todos os canais.
          </h2>
          <p className="max-w-md text-sm opacity-90">
            WhatsApp Cloud API, Evolution, automações N8N e comunicação interna —
            tudo em uma plataforma SaaS multiempresa, com isolamento total entre
            tenants.
          </p>
          <ul className="space-y-2 text-sm">
            <li className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Isolamento multiempresa por tenant</li>
            <li className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Perfis e permissões granulares</li>
            <li className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Auditoria completa de ações</li>
          </ul>
        </div>

        <div className="text-xs opacity-70">© {new Date().getFullYear()} NexaBoot</div>
      </aside>

      {/* Formulário */}
      <section className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-whatsapp text-whatsapp-foreground">
              <MessageCircle className="h-5 w-5" />
            </div>
            <div>
              <div className="text-lg font-semibold">NexaBoot</div>
              <div className="text-xs text-muted-foreground">Atendimento multicanal</div>
            </div>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">Entrar na sua conta</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Use suas credenciais corporativas para acessar a plataforma.
          </p>

          <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
            <div>
              <label className="text-sm font-medium" htmlFor="email">E-mail</label>
              <div className="relative mt-1">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={locked || submitting}
                  className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm outline-none ring-ring focus:ring-2 disabled:opacity-60"
                  placeholder="voce@empresa.com"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium" htmlFor="password">Senha</label>
                <button
                  type="button"
                  onClick={() => setForgotOpen(true)}
                  className="text-xs text-primary hover:underline"
                >
                  Esqueci minha senha
                </button>
              </div>
              <div className="relative mt-1">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={locked || submitting}
                  className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm outline-none ring-ring focus:ring-2 disabled:opacity-60"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              Lembrar-me neste dispositivo
            </label>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
                {attempts > 0 && !locked && (
                  <div className="mt-1 text-xs opacity-80">
                    Tentativas: {attempts}/5
                  </div>
                )}
              </div>
            )}

            {locked && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                Acesso temporariamente bloqueado por segurança. Tente novamente em{" "}
                <strong>{lockSeconds}s</strong>.
              </div>
            )}

            <button
              type="submit"
              disabled={locked || submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-whatsapp px-4 py-2.5 text-sm font-medium text-whatsapp-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {locked ? `Aguarde ${lockSeconds}s` : submitting ? "Entrando…" : "Entrar"}
            </button>
          </form>

        </div>
      </section>

      {forgotOpen && <ForgotPasswordModal onClose={() => setForgotOpen(false)} />}
    </div>
  );
}

function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      toast.error("Informe um e-mail válido.");
      return;
    }
    setSending(true);
    await requestPasswordReset(email);
    setSending(false);
    setSent(true);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold">Recuperar senha</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Informe seu e-mail e enviaremos instruções de recuperação.
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        {sent ? (
          <div className="mt-5 rounded-md border border-border bg-muted/40 p-4 text-sm">
            Se este e-mail estiver cadastrado, você receberá em instantes um link
            para redefinir sua senha. Verifique também sua caixa de spam.
            <div className="mt-3">
              <button
                onClick={onClose}
                className="rounded-md bg-whatsapp px-3 py-1.5 text-xs font-medium text-whatsapp-foreground hover:opacity-90"
              >
                Fechar
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@empresa.com"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-ring focus:ring-2"
            />
            <button
              type="submit"
              disabled={sending}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-whatsapp px-4 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
            >
              {sending && <Loader2 className="h-4 w-4 animate-spin" />}
              {sending ? "Enviando…" : "Enviar instruções"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
