import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsLoader } from "./test-support/isolated-postgres.mjs";
const { navigationAreas, navigationAreaForPath } = tsLoader()("src/lib/navigation-areas.ts");
const paths = navigationAreas.flatMap((a) => a.paths);
assert.equal(paths.length, new Set(paths).size);
assert.equal(paths.length, 19);
assert.equal(navigationAreaForPath("/campanhas/modelos"), "marketing");
assert.equal(navigationAreaForPath("/campanhas-falsa"), undefined);
assert.equal(navigationAreaForPath("/agenda"), "agenda");
let role = "ADMIN_EMPRESA",
  pathname = "/atendimento",
  companyValid = true;
const platform = () => ["SUPER_ADMIN", "TI", "ADMIN_GERAL"].includes(role);
const user = () => ({
  id: "test",
  name: "Pessoa Teste",
  role,
  tenantId: "company",
  avatarColor: "#008069",
});
const load = tsLoader({
  "@tanstack/react-router": {
    Link: ({ to, children, ...props }) => createElement("a", { href: to, ...props }, children),
    Outlet: () => null,
    useNavigate: () => () => {},
    useRouterState: ({ select }) => select({ location: { pathname } }),
  },
  "@/lib/auth": {
    useAuth: () => ({
      user: user(),
      companyId: companyValid ? "company" : null,
      companyName: "Empresa A",
      companyValid,
      platformAccess: platform(),
      switchingCompany: false,
    }),
  },
  "@/lib/session": {
    SessionProvider: ({ children }) => children,
    useSession: () => ({ user: user() }),
  },
  "@/hooks/use-mobile-viewport-height": { useMobileViewportHeight: () => undefined },
  "@/components/attendance-alert-banner": { AttendanceAlertBanner: () => null },
  "@/lib/notification-sound": {},
});
const { AppShell } = load("src/components/app-shell.tsx");
const html = () => renderToStaticMarkup(createElement(AppShell));
let page = html();
assert(page.includes('href="/agenda"'));
assert(!page.includes("Agenda da clínica"));
assert(page.includes("Marketing e automação"));
assert(page.includes('aria-label="Administração e configurações"'));
assert(page.includes('aria-current="page"'));
assert(!page.includes('href="/empresas"'));
assert(page.includes('href="/campanhas"'));
assert(page.includes('href="/gerencial"'));
for (const r of [
  "ATENDENTE",
  "ATENDENTE_GERAL",
  "SUPERVISOR",
  "GERENTE",
  "ADMIN_EMPRESA",
  "TI",
  "SUPER_ADMIN",
  "ADMIN_GERAL",
]) {
  role = r;
  page = html();
  assert.equal(
    page.includes('href="/agenda"'),
    ["ADMIN_EMPRESA", "TI", "SUPER_ADMIN", "ADMIN_GERAL"].includes(r),
    r + " agenda",
  );
  assert.equal(
    page.includes('href="/fluxos"'),
    ["ADMIN_EMPRESA", "TI", "SUPER_ADMIN", "ADMIN_GERAL"].includes(r),
    r + " fluxos",
  );
  assert.equal(page.includes('href="/empresas"'), platform(), r + " empresas");
  assert.equal(page.includes('href="/campanhas"'), r !== "ATENDENTE_GERAL", r + " campanhas");
  assert.equal(
    page.includes('href="/gerencial"'),
    !["ATENDENTE", "ATENDENTE_GERAL", "SUPERVISOR"].includes(r),
    r + " gerencial",
  );
}
role = "TI";
companyValid = false;
page = html();
assert(!page.includes('href="/campanhas"'));
assert(!page.includes('href="/gerencial"'));
role = "ADMIN_EMPRESA";
companyValid = true;
pathname = "/campanhas/modelos";
page = html();
assert.match(page, /aria-expanded="true"[^>]*>[\s\S]*?Marketing e automação/);
assert(
  page.includes('href="/campanhas" aria-current="page"') ||
    /href="\/campanhas"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/campanhas"/.test(
      page,
    ),
);
console.log(
  "PASS: 19 destinos únicos, áreas e rotas filhas, oito perfis, empresa válida, Agenda e administração da plataforma. Sem API ou mudança de permissões.",
);
