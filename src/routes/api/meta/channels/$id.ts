// PATCH /api/meta/channels/:id — atualiza canal Meta (token cifrado, nunca retornado).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import {
  META_CHANNEL_UUID_RE,
  buildMetaChannelPublic,
  ensureMetaTokenEncryptionConfigured,
  getMetaChannelRowForCompany,
  isMetaChannelStatus,
  storeMetaAccessTokenSafe,
} from "@/lib/meta-channels.server";
import { META_CHANNEL_STATUSES } from "@/lib/whatsapp/providers/whatsapp-provider.types";

const MetaStatusSchema = z.enum(META_CHANNEL_STATUSES);

const PatchMetaChannelBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    status: MetaStatusSchema.optional(),
    display_phone_number: z.string().trim().min(1).max(40).optional(),
    webhook_verify_token: z.string().trim().min(1).max(256).optional(),
    access_token: z.string().trim().min(1).max(4096).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.status !== undefined ||
      body.display_phone_number !== undefined ||
      body.webhook_verify_token !== undefined ||
      body.access_token !== undefined,
    { message: "empty_patch" },
  );

export const Route = createFileRoute("/api/meta/channels/$id")({
  server: {
    handlers: {
      PATCH: async ({ params, request }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        if (!META_CHANNEL_UUID_RE.test(params.id)) {
          return Response.json({ error: "invalid_id" }, { status: 400 });
        }

        const existing = await getMetaChannelRowForCompany(params.id, companyId);
        if (!existing) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        const json = await request.json().catch(() => null);
        const parsed = PatchMetaChannelBody.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input", detail: parsed.error.flatten() }, { status: 400 });
        }

        const { name, status, display_phone_number, webhook_verify_token, access_token } = parsed.data;

        if (status && !isMetaChannelStatus(status)) {
          return Response.json({ error: "invalid_status" }, { status: 400 });
        }

        if (access_token) {
          const encryptionError = ensureMetaTokenEncryptionConfigured();
          if (encryptionError) return encryptionError;
        }

        const s = sql();

        await s`
          UPDATE public.whatsapp_channels
          SET
            name = COALESCE(${name ?? null}, name),
            display_name = COALESCE(${name ?? null}, display_name),
            status = COALESCE(${status ?? null}, status),
            display_phone_number = COALESCE(${display_phone_number ?? null}, display_phone_number),
            webhook_verify_token = COALESCE(${webhook_verify_token ?? null}, webhook_verify_token),
            updated_at = now()
          WHERE id = ${params.id}::uuid
            AND company_id = ${companyId}::uuid
            AND lower(channel_type) = 'meta'
            AND deleted_at IS NULL
        `;

        if (access_token) {
          const tokenError = await storeMetaAccessTokenSafe(params.id, companyId, access_token);
          if (tokenError) return tokenError;
        }

        const row = await getMetaChannelRowForCompany(params.id, companyId);
        if (!row) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        const channel = await buildMetaChannelPublic(row);
        return Response.json({ ok: true, channel });
      },
    },
  },
});
