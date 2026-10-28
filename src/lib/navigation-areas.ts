export const navigationAreas = [
  { id: "overview", label: "Visão geral", paths: ["/dashboard", "/gerencial"] },
  { id: "attendance", label: "Atendimento", paths: ["/atendimento", "/espera", "/contatos"] },
  { id: "agenda", label: "Agenda", paths: ["/agenda"] },
  {
    id: "marketing",
    label: "Marketing e automação",
    paths: ["/campanhas", "/fluxos", "/lembretes"],
  },
  { id: "team", label: "Equipe", paths: ["/comunicacao-interna", "/grupos-internos"] },
  {
    id: "settings",
    label: "Configurações",
    paths: [
      "/usuarios",
      "/equipes-numeros",
      "/canais",
      "/horarios-acesso",
      "/configuracoes",
      "/automacoes",
      "/logs",
    ],
  },
  { id: "platform", label: "Administração", paths: ["/empresas"] },
] as const;
export function navigationAreaForPath(pathname: string) {
  return navigationAreas.find((area) =>
    area.paths.some((path) => pathname === path || pathname.startsWith(path + "/")),
  )?.id;
}
