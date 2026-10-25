import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requestRecovery, consumeRecovery } from "@/lib/password-recovery.server";
const RequestBody = z.object({ email: z.string().trim().email().max(255) });
const ResetBody = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  password: z
    .string()
    .min(10)
    .refine((p) => new TextEncoder().encode(p).length <= 72),
});
export const Route = createFileRoute("/api/auth/password-recovery")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = RequestBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: "invalid_email" }, { status: 400 });
        try {
          return Response.json(await requestRecovery(parsed.data.email));
        } catch {
          console.error("[PASSWORD_RECOVERY_UNAVAILABLE]");
          return Response.json(
            {
              error: "recovery_unavailable",
              message: "Recuperação indisponível. Contate o suporte.",
            },
            { status: 503 },
          );
        }
      },
      PUT: async ({ request }) => {
        const parsed = ResetBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
        const ok = await consumeRecovery(parsed.data.token, parsed.data.password);
        return ok
          ? Response.json({ ok: true })
          : Response.json(
              {
                error: "invalid_or_expired",
                message: "Link inválido, expirado ou já utilizado. Solicite outro.",
              },
              { status: 400 },
            );
      },
    },
  },
});
