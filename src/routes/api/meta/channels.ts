// GET  /api/meta/channels  — lista canais Meta da empresa (sem access_token).
// POST /api/meta/channels  — cadastro manual de canal Meta Cloud API.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureCrmSchema } from "@/lib/pg.server";
import { requireCompanyId } from "@/lib/company.server";
import {
  assertMetaPhoneNumberIdAvailable,
  buildMetaChannelPublic,
  ensureMetaTokenEncryptionConfigured,
  isMetaChannelStatus,
  listMetaChannelsForCompany,
  storeMetaAccessTokenSafe,
} from "@/lib/meta-channels.server";
import { META_CHANNEL_STATUSES } from "@/lib/whatsapp/providers/whatsapp-provider.types";

const MetaStatusSchema = z.enum(META_CHANNEL_STATUSES);

const CreateMetaChannelBody = z.object({
  name: z.string().trim().min(1).max(120),
  waba_id: z.string().trim().min(1).max(120),
  phone_number_id: z.string().trim().min(1).max(120),
  business_id: z.string().trim().min(1).max(120),
  display_phone_number: z.string().trim().min(1).max(40),
  access_token: z.string().trim().min(1).max(4096),
  webhook_verify_token: z.string().trim().min(1).max(256),
  status: MetaStatusSchema.optional(),
});

export const Route = createFileRoute("/api/meta/channels")({
  server: {
    handlers: {
      GET: async () => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;

        const channels = await listMetaChannelsForCompany(company);
        return Response.json({ channels });
      },

      POST: async ({ request }) => {
        await ensureCrmSchema();
        const company = await requireCompanyId();
        if (company instanceof Response) return company;
        const companyId = company;

        const encryptionError = ensureMetaTokenEncryptionConfigured();
        if (encryptionError) return encryptionError;

        const json = await request.json().catch(() => null);
        const parsed = CreateMetaChannelBody.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input", detail: parsed.error.flatten() }, { status: 400 });
        }

        const {
          name,
          waba_id,
          phone_number_id,
          business_id,
          display_phone_number,
          access_token,
          webhook_verify_token,
          status,
        } = parsed.data;

        const initialStatus = status ?? "ACTIVE";
        if (!isMetaChannelStatus(initialStatus)) {
          return Response.json({ error: "invalid_status" }, { status: 400 });
        }

        const conflict = await assertMetaPhoneNumberIdAvailable(phone_number_id, companyId);
        if (conflict) return conflict;

        const s = sql();
        let channelId: string;

        try {
          const inserted = await s<{ id: string }[]>`
            INSERT INTO public.whatsapp_channels (
              company_id, name, display_name, channel_type, status,
              waba_id, phone_number_id, business_id, display_phone_number,
              webhook_verify_token, token_status, active
            ) VALUES (
              ${companyId}::uuid, ${name}, ${name}, 'meta', ${initialStatus},
              ${waba_id}, ${phone_number_id}, ${business_id}, ${display_phone_number},
              ${webhook_verify_token}, 'pending', true
            )
            RETURNING id
          `;
          channelId = inserted[0].id;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("idx_channels_meta_phone_number_id") || msg.includes("duplicate key")) {
            return Response.json({ error: "phone_number_id_already_exists" }, { status: 409 });
          }
          console.error("[META_CHANNEL_CREATE_FAIL]", { error: msg });
          return Response.json({ error: "create_failed" }, { status: 500 });
        }

        const tokenError = await storeMetaAccessTokenSafe(channelId, companyId, access_token);
        if (tokenError) {
          await s`
            UPDATE public.whatsapp_channels
            SET active = false, deleted_at = now(), updated_at = now()
            WHERE id = ${channelId}::uuid AND company_id = ${companyId}::uuid
          `;
          return tokenError;
        }

        const row = await s`
          SELECT
            id, company_id, name, channel_type, status,
            waba_id, phone_number_id, business_id, display_phone_number,
            token_status, webhook_verify_token,
            last_error_code, last_error_message, last_webhook_at,
            created_at, updated_at
          FROM public.whatsapp_channels
          WHERE id = ${channelId}::uuid AND company_id = ${companyId}::uuid
        `;

        const channel = await buildMetaChannelPublic(row[0] as any);
        return Response.json({ ok: true, channel }, { status: 201 });
      },
    },
  },
});
