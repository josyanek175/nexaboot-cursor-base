// GET  /api/contacts        → lista contatos reais da empresa do logado.
//   Suporta busca por nome/telefone via ?q= (ILIKE no nome, dígitos no telefone).
// POST /api/contacts        → cria contato manual (dedupe por company_id+phone).
//
// Escopo SEMPRE por company_id do usuário logado (nunca expõe outra empresa).
// Não usa mocks. Os contatos recebidos pelo webhook da Evolution já caem aqui.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getCurrentUserCompanyId } from "@/lib/company.server";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().min(8).max(20),
  email: z.string().trim().email().max(255).optional().nullable(),
  reference: z.string().trim().max(160).optional().nullable(),
  status: z.enum(["ativo", "inativo", "lead"]).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).optional(),
  avatar_color: z.string().trim().max(20).optional().nullable(),
});

function normalizePhone(raw: string): string {
  return String(raw).replace(/\D+/g, "");
}

export const Route = createFileRoute("/api/contacts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await ensureCrmSchema();
        const companyId = await getCurrentUserCompanyId();
        if (!companyId) return Response.json({ error: "unauthorized" }, { status: 401 });

        const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
        const s = sql();

        const contacts = q
          ? await s`
              SELECT id, name, phone, email, reference, status, tags,
                     avatar_color, contact_type, external_jid, created_at, updated_at
              FROM public.contacts
              WHERE company_id = ${companyId}::uuid
                AND (
                  name ILIKE ${"%" + q + "%"}
                  OR phone LIKE ${"%" + normalizePhone(q) + "%"}
                  OR email ILIKE ${"%" + q + "%"}
                )
              ORDER BY created_at DESC
              LIMIT 1000
            `
          : await s`
              SELECT id, name, phone, email, reference, status, tags,
                     avatar_color, contact_type, external_jid, created_at, updated_at
              FROM public.contacts
              WHERE company_id = ${companyId}::uuid
              ORDER BY created_at DESC
              LIMIT 1000
            `;
        return Response.json({ contacts });
      },

      POST: async ({ request }) => {
        await ensureCrmSchema();
        const companyId = await getCurrentUserCompanyId();
        if (!companyId) return Response.json({ error: "unauthorized" }, { status: 401 });

        const json = await request.json().catch(() => null);
        const parsed = CreateBody.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input", detail: parsed.error.flatten() }, { status: 400 });
        }
        const d = parsed.data;
        const phone = normalizePhone(d.phone);
        if (phone.length < 8 || phone.length > 15) {
          return Response.json({ error: "invalid_phone" }, { status: 400 });
        }

        const s = sql();
        // Dedupe por (company_id, phone): não duplica contato existente.
        const inserted = await s<{ id: string }[]>`
          INSERT INTO public.contacts
            (company_id, phone, name, email, reference, status, tags, avatar_color, contact_type)
          VALUES
            (${companyId}::uuid, ${phone}, ${d.name},
             ${d.email ?? null}, ${d.reference ?? null}, ${d.status ?? "ativo"},
             ${d.tags ?? null}, ${d.avatar_color ?? null}, 'individual')
          ON CONFLICT (company_id, phone) DO NOTHING
          RETURNING id
        `;
        if (!inserted[0]) {
          return Response.json({ error: "phone_already_exists" }, { status: 409 });
        }
        const rows = await s`
          SELECT id, name, phone, email, reference, status, tags,
                 avatar_color, contact_type, external_jid, created_at, updated_at
          FROM public.contacts WHERE id = ${inserted[0].id}::uuid
        `;
        return Response.json({ contact: rows[0] }, { status: 201 });
      },
    },
  },
});
