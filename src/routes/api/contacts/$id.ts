// PUT    /api/contacts/:id → atualiza contato (escopo da empresa do logado).
// DELETE /api/contacts/:id → remove contato (escopo da empresa do logado).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { getCurrentUserCompanyId } from "@/lib/company.server";
import { normalizePhone } from "@/lib/phone";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UpdateBody = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  phone: z.string().trim().min(8).max(20).optional(),
  email: z.string().trim().email().max(255).optional().nullable(),
  reference: z.string().trim().max(160).optional().nullable(),
  status: z.enum(["ativo", "inativo", "lead"]).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).optional(),
  avatar_color: z.string().trim().max(20).optional().nullable(),
});

export const Route = createFileRoute("/api/contacts/$id")({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        await ensureCrmSchema();
        const companyId = await getCurrentUserCompanyId();
        if (!companyId) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });

        const json = await request.json().catch(() => null);
        const parsed = UpdateBody.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input", detail: parsed.error.flatten() }, { status: 400 });
        }
        const d = parsed.data;
        const phone = d.phone !== undefined ? normalizePhone(d.phone) : undefined;
        if (phone !== undefined && (phone.length < 8 || phone.length > 15)) {
          return Response.json({ error: "invalid_phone" }, { status: 400 });
        }

        const s = sql();
        const owns = await s`
          SELECT id FROM public.contacts
          WHERE id = ${params.id}::uuid AND company_id = ${companyId}::uuid
          LIMIT 1
        `;
        if (!owns[0]) return Response.json({ error: "not_found" }, { status: 404 });

        try {
          // Edição pela tela /contatos é sempre manual: ao alterar o nome,
          // marca name_source='manual' para nunca ser sobrescrito pelo pushName.
          const nameSource = d.name !== undefined ? "manual" : null;
          const rows = await s`
            UPDATE public.contacts SET
              name         = COALESCE(${d.name ?? null}, name),
              name_source  = COALESCE(${nameSource}, name_source),
              phone        = COALESCE(${phone ?? null}, phone),
              email        = ${d.email ?? null},
              reference    = ${d.reference ?? null},
              status       = COALESCE(${d.status ?? null}, status),
              tags         = ${d.tags ?? null},
              avatar_color = COALESCE(${d.avatar_color ?? null}, avatar_color),
              updated_at   = now()
            WHERE id = ${params.id}::uuid AND company_id = ${companyId}::uuid
            RETURNING id, name, phone, email, reference, status, tags,
                      avatar_color, contact_type, external_jid, name_source,
                      created_at, updated_at
          `;
          return Response.json({ contact: rows[0] });
        } catch (e) {
          const err = e as { code?: string; detail?: string; message?: string };
          if (err.code === "23505") {
            return Response.json({ error: "phone_already_exists" }, { status: 409 });
          }
          console.error("[CONTACT_UPDATE_FAIL]", err);
          return Response.json({ error: "update_failed", detail: err.detail ?? err.message }, { status: 500 });
        }
      },

      // Regra de segurança NexaBoot: NÃO existe exclusão física pela API.
      // O verbo DELETE é convertido em inativação lógica (status = 'inativo').
      // O registro permanece no banco; conversas e mensagens são preservadas.
      // Exclusão definitiva só pela TI, diretamente no banco de dados.
      DELETE: async ({ params }) => {
        await ensureCrmSchema();
        const companyId = await getCurrentUserCompanyId();
        if (!companyId) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!UUID_RE.test(params.id)) return Response.json({ error: "invalid_id" }, { status: 400 });

        const s = sql();
        const rows = await s`
          UPDATE public.contacts
          SET status = 'inativo', updated_at = now()
          WHERE id = ${params.id}::uuid AND company_id = ${companyId}::uuid
          RETURNING id, name, phone, email, reference, status, tags,
                    avatar_color, contact_type, external_jid, created_at, updated_at
        `;
        if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ ok: true, inactivated: true, contact: rows[0] });
      },
    },
  },
});
