const reserved = new Set([
  "politica-de-privacidade",
  "termos-de-uso",
  "exclusao-de-dados",
  "api",
  "login",
  "register",
  "dashboard",
  "atendimento",
  "contatos",
  "campanhas",
  "gerencial",
  "espera",
  "empresas",
  "usuarios",
  "canais",
  "whatsapp",
  "fluxos",
  "lembretes",
  "configuracoes",
  "seguranca",
  "horarios-acesso",
  "comunicacao-interna",
  "grupos-internos",
  "logs",
  "planos",
  "webhook",
  "assets",
  "_build",
  "_server",
  "favicon",
  "robots",
  "sitemap",
  "index",
  "internal-chat",
  "n8n",
  "automacoes",
]);

export function validWorkspaceSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,47}$/.test(value) && !reserved.has(value);
}

export function workspaceFromPath(path: string): string | null {
  const first = path.split("/")[1] ?? "";
  return validWorkspaceSlug(first) ? first : null;
}

/** Per-router state; never share a company's URL between SSR requests. */
export function workspaceRewrite() {
  let slug: string | null = null;
  return {
    input: ({ url }: { url: URL }) => {
      const current = workspaceFromPath(url.pathname);
      if (current) {
        slug = current;
        url.pathname = url.pathname.slice(current.length + 1) || "/";
      }
      return url;
    },
    output: ({ url }: { url: URL }) => {
      if (slug && !url.pathname.startsWith("/api/") && workspaceFromPath(url.pathname) !== slug)
        url.pathname = `/${slug}${url.pathname === "/" ? "" : url.pathname}`;
      return url;
    },
  };
}
