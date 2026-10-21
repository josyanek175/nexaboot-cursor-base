import { createFileRoute } from "@tanstack/react-router";
import { sql } from "@/lib/pg.server";
import { requireSession } from "@/lib/session.server";
import { isPlatformRole } from "@/lib/platform-roles";
import { validWorkspaceSlug } from "@/lib/workspace-path";

export const Route = createFileRoute("/api/companies/$id/workspace")({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        const session = await requireSession();
        if (session instanceof Response) return session;
        if (!/^[0-9a-f-]{36}$/i.test(params.id))
          return Response.json({ error: "invalid_company" }, { status: 400 });
        const users = await sql<
          { role: string; company_id: string | null }[]
        >`SELECT role,company_id
        FROM public.users WHERE id=${session.userId}::uuid AND active=true LIMIT 1`;
        const actor = users[0];
        if (
          !actor ||
          (!isPlatformRole(actor.role) &&
            !(actor.role === "ADMIN_EMPRESA" && actor.company_id === params.id))
        )
          return Response.json({ error: "forbidden" }, { status: 403 });
        const body = await request.json().catch(() => null);
        const slug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";
        if (!validWorkspaceSlug(slug))
          return Response.json(
            {
              error: "invalid_slug",
              message:
                "Use de 2 a 48 letras minúsculas, números ou hífens. Endereços do sistema são reservados.",
            },
            { status: 400 },
          );
        try {
          const rows = await sql<
            { id: string }[]
          >`UPDATE public.companies SET slug=${slug},updated_at=now()
          WHERE id=${params.id}::uuid AND active=true RETURNING id`;
          if (!rows[0]) return Response.json({ error: "company_not_found" }, { status: 404 });
          return Response.json({ slug, path: `/${slug}` });
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "23505")
            return Response.json(
              { error: "slug_taken", message: "Este endereço já está em uso." },
              { status: 409 },
            );
          if (code === "42703")
            return Response.json(
              {
                error: "workspace_schema_missing",
                message: "A configuração de endereços ainda não foi preparada neste ambiente.",
              },
              { status: 503 },
            );
          throw error;
        }
      },
    },
  },
});
