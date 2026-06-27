// Seed idempotente dos usuários de teste solicitados.
// Acesso: GET ou POST /api/admin/seed-demo
// Cria o tenant "Filtros e Velas" e os usuários com senha "demo123".
import { createFileRoute } from "@tanstack/react-router";
import bcrypt from "bcryptjs";
import { sql, ensureSchema } from "@/lib/pg.server";

type SeedUser = {
  email: string;
  name: string;
  role: string;
  tenant_id: string;
  active: boolean;
};

const TENANT_FV = { id: "filtros-e-velas", name: "Filtros e Velas", slug: "filtros-e-velas" };

const USERS: SeedUser[] = [
  { email: "josyane@nexaboot.com", name: "Josyane", role: "SUPER_ADMIN", tenant_id: "default", active: true },
  { email: "bruno@nexaboot.com", name: "Bruno", role: "TI", tenant_id: "default", active: true },
  { email: "gustavo@lojaverde.com", name: "Gustavo", role: "USER", tenant_id: "default", active: false },
  { email: "marcelasousa.advocacia@hotmail.com", name: "Marcela Sousa", role: "ADMIN_EMPRESA", tenant_id: TENANT_FV.id, active: true },
];

async function runSeed() {
  await ensureSchema();
  const s = sql();
  const passwordHash = await bcrypt.hash("demo123", 10);

  // Tenant Filtros e Velas
  await s`
    INSERT INTO public.tenants (id, name, slug, active)
    VALUES (${TENANT_FV.id}, ${TENANT_FV.name}, ${TENANT_FV.slug}, true)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, updated_at = now()
  `;

  const results: Array<{ email: string; action: string }> = [];
  for (const u of USERS) {
    const existing = await s`SELECT id FROM public.users WHERE email = ${u.email} LIMIT 1`;
    if (existing.length) {
      await s`
        UPDATE public.users SET
          name = ${u.name},
          role = ${u.role},
          tenant_id = ${u.tenant_id},
          active = ${u.active},
          password_hash = ${passwordHash},
          updated_at = now()
        WHERE id = ${existing[0].id}
      `;
      results.push({ email: u.email, action: "updated" });
    } else {
      await s`
        INSERT INTO public.users (tenant_id, name, email, password_hash, role, active)
        VALUES (${u.tenant_id}, ${u.name}, ${u.email}, ${passwordHash}, ${u.role}, ${u.active})
      `;
      results.push({ email: u.email, action: "created" });
    }
  }

  return { ok: true, tenant: TENANT_FV, users: results };
}

export const Route = createFileRoute("/api/admin/seed-demo")({
  server: {
    handlers: {
      GET: async () => {
        try {
          return Response.json(await runSeed());
        } catch (e) {
          const err = e as Error;
          console.error("[SEED_DEMO_FAIL]", err);
          return Response.json({ ok: false, error: err.message }, { status: 500 });
        }
      },
      POST: async () => {
        try {
          return Response.json(await runSeed());
        } catch (e) {
          const err = e as Error;
          console.error("[SEED_DEMO_FAIL]", err);
          return Response.json({ ok: false, error: err.message }, { status: 500 });
        }
      },
    },
  },
});
