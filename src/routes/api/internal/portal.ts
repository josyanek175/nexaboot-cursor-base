import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSql } from "@/lib/pg.server";
import { listCompaniesWithPlanUsage } from "@/lib/subscription.server";
import { verifyPortalRequest } from "@/lib/portal-integration-auth.server";
import { COMPANY_USER_ROLES, canManageUserTarget } from "@/lib/user-management-policy";

const company = z.string().uuid();
const userFields = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  role: z.string().refine((r) => COMPANY_USER_ROLES.includes(r)),
  active: z.boolean(),
  password: z.string().min(8).max(200).optional(),
});
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("overview") }),
  z.object({
    action: z.literal("createCompany"),
    name: z.string().trim().min(2).max(200),
    planId: company,
    adminName: z.string().trim().min(2).max(120),
    adminEmail: z.string().trim().email().max(255),
    password: z.string().min(8).max(200),
  }),
  z.object({
    action: z.literal("updateCompany"),
    companyId: company,
    name: z.string().trim().min(2).max(200),
    active: z.boolean(),
  }),
  z.object({ action: z.literal("assignPlan"), companyId: company, planId: company }),
  z.object({ action: z.literal("listUsers"), companyId: company }),
  z.object({ action: z.literal("createUser"), companyId: company, user: userFields }),
  z.object({
    action: z.literal("updateUser"),
    companyId: company,
    userId: company,
    user: userFields,
  }),
]);

export const Route = createFileRoute("/api/internal/portal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.NEXA_PORTAL_INTEGRATION_SECRET;
        if (!secret || secret.length < 32)
          return Response.json({ error: "integration_not_configured" }, { status: 503 });
        // Limit the body before buffering so an unauthenticated caller cannot allocate unbounded memory.
        const reader = request.body?.getReader();
        if (!reader) return Response.json({ error: "invalid_input" }, { status: 400 });
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 32768) {
            await reader.cancel();
            return Response.json({ error: "payload_too_large" }, { status: 413 });
          }
          chunks.push(next.value);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!verifyPortalRequest(request, raw, secret))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }
        const parsed = inputSchema.safeParse(json);
        if (!parsed.success)
          return Response.json(
            { error: "invalid_input", message: "Confira os campos informados." },
            { status: 400 },
          );
        const input = parsed.data;
        const db = getSql();
        const reply = (data: unknown, status = 200) =>
          Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
        try {
          if (input.action === "overview") {
            const [companies, plans] = await Promise.all([
              listCompaniesWithPlanUsage({}),
              db`SELECT id,name,code,max_users,max_whatsapp_channels FROM public.plans WHERE active=true ORDER BY name`,
            ]);
            return reply({ companies, plans });
          }
          if (input.action === "createCompany") {
            const hash = await bcrypt.hash(input.password, 10);
            return await db.begin(async (tx) => {
              await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"portal-email:" + input.adminEmail.toLowerCase()},0))`;
              const plans =
                await tx`SELECT id FROM public.plans WHERE id=${input.planId}::uuid AND active=true`;
              if (!plans[0]) return reply({ error: "plan_not_found" }, 400);
              const existing =
                await tx`SELECT id FROM public.users WHERE lower(email)=${input.adminEmail.toLowerCase()}`;
              if (existing[0]) return reply({ error: "email_already_exists" }, 409);
              // Keep the legacy tenant label compatible; company_id is the isolation boundary.
              const companies =
                await tx`INSERT INTO public.companies (name,active) VALUES (${input.name},true) RETURNING id`;
              const id = String(companies[0].id);
              await tx`INSERT INTO public.company_subscriptions(company_id,plan_id,status) VALUES (${id}::uuid,${input.planId}::uuid,'active')`;
              await tx`INSERT INTO public.users(tenant_id,company_id,name,email,password_hash,role,active) VALUES ('default',${id}::uuid,${input.adminName},${input.adminEmail.toLowerCase()},${hash},'ADMIN_EMPRESA',true)`;
              return reply({ ok: true, companyId: id }, 201);
            });
          }
          if (input.action === "listUsers") {
            const users =
              await db`SELECT id,name,email,role,active FROM public.users WHERE company_id=${input.companyId}::uuid ORDER BY name`;
            return reply({ users });
          }
          if (input.action === "updateCompany") {
            const rows =
              await db`UPDATE public.companies SET name=${input.name},active=${input.active},updated_at=now() WHERE id=${input.companyId}::uuid RETURNING id`;
            return rows[0] ? reply({ ok: true }) : reply({ error: "not_found" }, 404);
          }
          if (input.action === "assignPlan")
            return await db.begin(async (tx) => {
              const companies =
                await tx`SELECT id FROM public.companies WHERE id=${input.companyId}::uuid FOR UPDATE`;
              if (!companies[0]) return reply({ error: "not_found" }, 404);
              const plans =
                await tx`SELECT id FROM public.plans WHERE id=${input.planId}::uuid AND active=true`;
              if (!plans[0]) return reply({ error: "plan_not_found" }, 400);
              await tx`UPDATE public.company_subscriptions SET status='canceled',canceled_at=now(),updated_at=now() WHERE company_id=${input.companyId}::uuid AND status='active'`;
              await tx`INSERT INTO public.company_subscriptions(company_id,plan_id,status) VALUES (${input.companyId}::uuid,${input.planId}::uuid,'active')`;
              return reply({ ok: true });
            });
          const user = input.user;
          if (input.action === "createUser" && !user.password)
            return reply({ error: "password_required" }, 400);
          const hash = user.password ? await bcrypt.hash(user.password, 10) : null;
          return await db.begin(async (tx) => {
            const companies =
              await tx`SELECT id FROM public.companies WHERE id=${input.companyId}::uuid AND active=true FOR UPDATE`;
            if (!companies[0]) return reply({ error: "company_inactive_or_missing" }, 400);
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"portal-email:" + user.email.toLowerCase()},0))`;
            const emails =
              await tx`SELECT id FROM public.users WHERE lower(email)=${user.email.toLowerCase()}
        AND (${input.action === "updateUser" ? input.userId : null}::uuid IS NULL OR id<>${input.action === "updateUser" ? input.userId : null}::uuid)`;
            if (emails[0]) return reply({ error: "email_already_exists" }, 409);
            if (input.action === "updateUser") {
              const targets =
                await tx`SELECT role FROM public.users WHERE id=${input.userId}::uuid AND company_id=${input.companyId}::uuid FOR UPDATE`;
              if (!targets[0]) return reply({ error: "not_found" }, 404);
              if (!canManageUserTarget("ADMIN_EMPRESA", String(targets[0].role)))
                return reply({ error: "platform_identity_protected" }, 403);
              if (
                targets[0].role === "ADMIN_EMPRESA" &&
                (!user.active || user.role !== "ADMIN_EMPRESA")
              ) {
                const admins =
                  await tx`SELECT id FROM public.users WHERE company_id=${input.companyId}::uuid AND role='ADMIN_EMPRESA' AND active=true AND id<>${input.userId}::uuid`;
                if (!admins[0]) return reply({ error: "last_company_admin" }, 409);
              }
              await tx`UPDATE public.users SET name=${user.name},email=${user.email.toLowerCase()},role=${user.role},active=${user.active},password_hash=COALESCE(${hash},password_hash),updated_at=now() WHERE id=${input.userId}::uuid AND company_id=${input.companyId}::uuid`;
            } else {
              await tx`INSERT INTO public.users(tenant_id,company_id,name,email,password_hash,role,active) VALUES ('default',${input.companyId}::uuid,${user.name},${user.email.toLowerCase()},${hash},${user.role},${user.active})`;
            }
            return reply({ ok: true });
          });
        } catch (error) {
          if ((error as { code?: string }).code === "23505")
            return reply({ error: "email_already_exists" }, 409);
          console.error("[PORTAL_INTEGRATION_FAILED]", {
            action: input.action,
            code: (error as { code?: string }).code ?? "internal",
          });
          return reply(
            { error: "operation_failed", message: "Não foi possível concluir a operação." },
            500,
          );
        }
      },
    },
  },
});
