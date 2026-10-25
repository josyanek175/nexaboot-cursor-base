// Emergency password reset: disabled unless explicitly enabled with its own token.
// Segurança:
//  - Exige ADMIN_PASSWORD_RESET_ENABLED=true e ADMIN_SETUP_TOKEN próprio.
//  - NUNCA grava senha pura: sempre bcrypt.hash(novaSenha, 10).
//  - NUNCA retorna o hash.
//
// Uso:
//   POST /api/admin/reset-password
//   body: { "token": "<ADMIN_SETUP_TOKEN>",
//           "email": "josyane@nexaboot.com",
//           "newPassword": "<senha escolhida com pelo menos 10 caracteres>" }
//
// REMOVA esta rota após concluir o diagnóstico.
import { createFileRoute } from "@tanstack/react-router";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { sql } from "@/lib/pg.server";

const Body = z.object({
  token: z.string().min(1),
  email: z.string().email().max(255),
  newPassword: z.string().min(10).max(72).refine(p=>Buffer.byteLength(p,'utf8')<=72),
});

function expectedToken(): string | null {
  return process.env.ADMIN_PASSWORD_RESET_ENABLED === "true" ? process.env.ADMIN_SETUP_TOKEN || null : null;
}

function tokensMatch(provided: string, expected: string): boolean {
  // Comparação de tamanho constante simples.
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/admin/reset-password")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = expectedToken();
        if (!expected) {
          return Response.json(
            {
              error: "guard_not_configured",
              reason:
                "A recuperação emergencial está desativada.",
            },
            { status: 403 },
          );
        }

        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input", detail: parsed.error.flatten() }, { status: 400 });
        }

        if (!tokensMatch(parsed.data.token, expected)) {
          console.warn("[RESET_PASSWORD_FORBIDDEN]", { email: parsed.data.email });
          return Response.json({ error: "forbidden" }, { status: 403 });
        }

        const email = parsed.data.email.trim().toLowerCase();
        const newPassword = parsed.data.newPassword;

        try {
          const s = sql();
          const existing = await s`
            SELECT id, email, tenant_id, active FROM public.users WHERE lower(email) = ${email} LIMIT 1
          `;
          const u = existing[0];
          if (!u) {
            return Response.json({ error: "user_not_found", email }, { status: 404 });
          }

          const hash = await bcrypt.hash(newPassword, 10);
          await s`
            UPDATE public.users
            SET password_hash = ${hash}, updated_at = now()
            WHERE id = ${u.id}
          `;

          console.log("[RESET_PASSWORD_OK]", {
            userId: u.id,
            email: u.email,
            tenant_id: u.tenant_id,
            hashPrefix: hash.slice(0, 4),
          });

          return Response.json({
            ok: true,
            email: u.email,
            tenant_id: u.tenant_id,
            active: u.active,
            hashPrefix: hash.slice(0, 4), // confirma que é bcrypt; não expõe o hash
            note: "Senha redefinida. Teste o login agora. Remova esta rota após o diagnóstico.",
          });
        } catch (e: any) {
          console.error("[RESET_PASSWORD_FAIL]", { email, message: e?.message ?? String(e) });
          return Response.json({ error: "db_error", message: e?.message ?? String(e) }, { status: 500 });
        }
      },
    },
  },
});
