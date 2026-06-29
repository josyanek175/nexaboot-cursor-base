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
import { normalizePhone, normalizePhoneForMatch } from "@/lib/phone";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().min(8).max(20),
  email: z.string().trim().email().max(255).optional().nullable(),
  reference: z.string().trim().max(160).optional().nullable(),
  status: z.enum(["ativo", "inativo", "lead"]).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).optional(),
  avatar_color: z.string().trim().max(20).optional().nullable(),
});

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
                     avatar_color, contact_type, external_jid, name_source,
                     created_at, updated_at
              FROM public.contacts
              WHERE company_id = ${companyId}::uuid
                AND status IS DISTINCT FROM 'merged'
                AND (
                  name ILIKE ${"%" + q + "%"}
                  OR phone LIKE ${"%" + normalizePhone(q) + "%"}
                  OR phone_match LIKE ${"%" + normalizePhoneForMatch(q) + "%"}
                  OR email ILIKE ${"%" + q + "%"}
                )
              ORDER BY created_at DESC
              LIMIT 1000
            `
          : await s`
              SELECT id, name, phone, email, reference, status, tags,
                     avatar_color, contact_type, external_jid, name_source,
                     created_at, updated_at
              FROM public.contacts
              WHERE company_id = ${companyId}::uuid
                AND status IS DISTINCT FROM 'merged'
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
        // Chave canônica tolerante ao nono dígito BR (com/sem 9 = mesmo número).
        const phoneMatch = normalizePhoneForMatch(phone);

        const s = sql();

        // 1) Já existe contato ATIVO com variante equivalente? Não duplica.
        const active = await s<{ id: string }[]>`
          SELECT id FROM public.contacts
          WHERE company_id = ${companyId}::uuid AND phone_match = ${phoneMatch}
            AND status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo'
          LIMIT 1
        `;
        if (active[0]) {
          return Response.json({ error: "phone_already_exists" }, { status: 409 });
        }

        // 2) Existe inativo/merged com variante equivalente? Reaproveita (reativa),
        //    preservando o histórico — em vez de criar outro contato.
        const reusable = await s<{ id: string }[]>`
          SELECT id FROM public.contacts
          WHERE company_id = ${companyId}::uuid AND phone_match = ${phoneMatch}
            AND (status = 'inativo' OR status = 'merged')
          ORDER BY (status = 'inativo') DESC, updated_at DESC
          LIMIT 1
        `;
        if (reusable[0]) {
          const rows = await s`
            UPDATE public.contacts SET
              name = ${d.name}, name_source = 'manual',
              phone = ${phone}, phone_match = ${phoneMatch},
              email = ${d.email ?? null}, reference = ${d.reference ?? null},
              status = ${d.status ?? "ativo"}, tags = ${d.tags ?? null},
              avatar_color = ${d.avatar_color ?? null}, updated_at = now()
            WHERE id = ${reusable[0].id}::uuid
            RETURNING id, name, phone, email, reference, status, tags,
                      avatar_color, contact_type, external_jid, name_source,
                      created_at, updated_at
          `;
          console.log("[CONTACT_REUSED_ON_CREATE]", { id: reusable[0].id, phone });
          return Response.json({ contact: rows[0], reused: true }, { status: 200 });
        }

        // 3) Cria novo contato manual.
        try {
          const inserted = await s<{ id: string }[]>`
            INSERT INTO public.contacts
              (company_id, phone, phone_match, name, name_source, email, reference, status,
               tags, avatar_color, contact_type)
            VALUES
              (${companyId}::uuid, ${phone}, ${phoneMatch}, ${d.name}, 'manual',
               ${d.email ?? null}, ${d.reference ?? null}, ${d.status ?? "ativo"},
               ${d.tags ?? null}, ${d.avatar_color ?? null}, 'individual')
            RETURNING id
          `;
          const rows = await s`
            SELECT id, name, phone, email, reference, status, tags,
                   avatar_color, contact_type, external_jid, name_source,
                   created_at, updated_at
            FROM public.contacts WHERE id = ${inserted[0].id}::uuid
          `;
          return Response.json({ contact: rows[0] }, { status: 201 });
        } catch (e) {
          const err = e as { code?: string };
          if (err.code === "23505") {
            return Response.json({ error: "phone_already_exists" }, { status: 409 });
          }
          throw e;
        }
      },
    },
  },
});
