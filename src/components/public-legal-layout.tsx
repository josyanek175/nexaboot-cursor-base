import { Link } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";
import type { ReactNode } from "react";

export const LEGAL_CONTACT_EMAIL = "contato@nexatech.com";
export const LEGAL_UPDATED_AT = "Julho de 2026";

const LEGAL_LINKS = [
  { to: "/politica-de-privacidade" as const, label: "Política de Privacidade" },
  { to: "/termos-de-uso" as const, label: "Termos de Uso" },
  { to: "/exclusao-de-dados" as const, label: "Exclusão de Dados" },
];

type PublicLegalLayoutProps = {
  title: string;
  children: ReactNode;
  /** Rota atual para destacar no rodapé (opcional). */
  currentPath?: string;
};

export function PublicLegalLayout({ title, children, currentPath }: PublicLegalLayoutProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <Link to="/login" className="flex items-center gap-3 hover:opacity-90">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-whatsapp text-whatsapp-foreground">
              <MessageCircle className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">NexaBoot</div>
              <div className="text-xs text-muted-foreground">NexaTech</div>
            </div>
          </Link>
          <Link to="/login" className="text-sm font-medium text-primary hover:underline">
            Entrar
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <article className="max-w-none">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Última atualização: {LEGAL_UPDATED_AT}
          </p>
          {children}
        </article>
      </main>

      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 sm:justify-start">
            {LEGAL_LINKS.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={
                  currentPath === link.to
                    ? "font-medium text-foreground"
                    : "hover:text-foreground hover:underline"
                }
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="flex flex-col items-center justify-between gap-2 text-center sm:flex-row sm:text-left">
            <span>
              © {new Date().getFullYear()} NexaBoot — NexaTech ·{" "}
              <a
                href={`mailto:${LEGAL_CONTACT_EMAIL}`}
                className="hover:text-foreground hover:underline"
              >
                {LEGAL_CONTACT_EMAIL}
              </a>
            </span>
            <Link to="/login" className="hover:text-foreground hover:underline">
              Voltar ao login
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-8 space-y-3 first:mt-10">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="space-y-3 text-muted-foreground leading-relaxed">{children}</div>
    </section>
  );
}
