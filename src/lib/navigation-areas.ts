export const navigationAreas = [
  { id: "inbox", label: "Atendimento", paths: ["/atendimento"] },
  { id: "campaigns", label: "Campanhas", paths: ["/campanhas"] },
  { id: "chat", label: "Chat interno", paths: ["/comunicacao-interna"] },
  { id: "overview", label: "Visão geral", paths: ["/dashboard", "/gerencial"] },
  { id: "attendance", label: "Clientes", paths: ["/espera", "/contatos"] },
  { id: "agenda", label: "Agenda", paths: ["/agenda"] },
  {
    id: "marketing",
    label: "Automação",
    paths: ["/fluxos", "/lembretes"],
  },
  { id: "team", label: "Equipe", paths: ["/grupos-internos"] },
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
