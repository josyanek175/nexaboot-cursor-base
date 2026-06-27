import { createFileRoute } from "@tanstack/react-router";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { sql, ensureSchema } from "@/lib/pg.server";
import { setSessionCookie } from "@/lib/session.server";

const Body = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureSchema();
        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input" }, { status: 400 });
        }
        const email = parsed.data.email.trim().toLowerCase();
        const password = parsed.data.password;
        console.log("[AUTH_LOGIN_ATTEMPT]", { email });

        const s = sql();
        const rows = await s`
          SELECT id, email, name, role, tenant_id, password_hash, active
          FROM public.users
          WHERE lower(email) = ${email}
          LIMIT 1
        `;
        const u = rows[0];
        console.log("[AUTH_LOGIN_USER_FOUND]", {
          email,
          found: !!u,
          active: u?.active,
          role: u?.role,
          tenant_id: u?.tenant_id,
        });

        if (!u) {
          return Response.json({ error: "invalid_credentials" }, { status: 401 });
        }
        if (u.active === false) {
          return Response.json({ error: "blocked" }, { status: 403 });
        }
        if (!u.password_hash || typeof u.password_hash !== "string") {
          return Response.json({ error: "invalid_credentials" }, { status: 401 });
        }

        const ok = await bcrypt.compare(password, u.password_hash);
        if (!ok) {
          return Response.json({ error: "invalid_credentials" }, { status: 401 });
        }

        try {
          await s`UPDATE public.users SET last_login_at = now() WHERE id = ${u.id}`;
        } catch (e) {
          console.log("[AUTH_LOGIN_LAST_LOGIN_UPDATE_FAILED]", { userId: u.id });
        }

        setSessionCookie(u.id);
        console.log("[AUTH_LOGIN_SUCCESS]", { userId: u.id, email: u.email });

        return Response.json({
          user: {
            id: u.id,
            email: u.email,
            name: u.name,
            role: u.role,
            tenant_id: u.tenant_id,
          },
        });
      },
    },
  },
});
