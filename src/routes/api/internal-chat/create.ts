import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sql, ensureSchema } from "@/lib/pg.server";
import { getSessionUserId } from "@/lib/session.server";

const Body = z.object({
  title: z.string().trim().max(120).optional(),
  type: z.enum(["direct", "group"]),
  memberIds: z.array(z.string().uuid()).min(1).max(100),
});

export const Route = createFileRoute("/api/internal-chat/create")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await ensureSchema();
        const uid = getSessionUserId();
        if (!uid) return Response.json({ error: "unauthorized" }, { status: 401 });
        const json = await request.json().catch(() => null);
        const parsed = Body.safeParse(json);
        if (!parsed.success) {
          return Response.json({ error: "invalid_input", issues: parsed.error.flatten() }, { status: 400 });
        }
        const { title, type, memberIds } = parsed.data;

        const s = sql();
        const meRow = await s`SELECT id, tenant_id, name FROM users WHERE id = ${uid}`;
        if (!meRow.length) return Response.json({ error: "unauthorized" }, { status: 401 });
        const tenantId: string | null = meRow[0].tenant_id;

        // Garante todos os membros são do mesmo tenant
        const memberSet = Array.from(new Set(memberIds.filter((id) => id !== uid)));
        if (type === "direct" && memberSet.length !== 1) {
          return Response.json({ error: "direct_requires_exactly_one_other" }, { status: 400 });
        }
        if (type === "group" && !title) {
          return Response.json({ error: "group_requires_title" }, { status: 400 });
        }

        if (memberSet.length > 0) {
          const found = tenantId
            ? await s`SELECT id FROM users WHERE id = ANY(${memberSet}) AND tenant_id = ${tenantId}`
            : await s`SELECT id FROM users WHERE id = ANY(${memberSet}) AND tenant_id IS NULL`;
          if (found.length !== memberSet.length) {
            return Response.json({ error: "member_outside_tenant" }, { status: 403 });
          }
        }

        const allMembers = Array.from(new Set([uid, ...memberSet]));
        if (allMembers.length < 2) {
          return Response.json({ error: "chat_requires_members" }, { status: 400 });
        }

        // Para direct, reutilizar se já existe entre os 2
        if (type === "direct") {
          const other = memberSet[0];
          const existing = await s`
            SELECT c.id
            FROM internal_chats c
            JOIN internal_chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ${uid}
            JOIN internal_chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ${other}
            WHERE c.type = 'direct'
              AND (SELECT COUNT(*) FROM internal_chat_members mc WHERE mc.chat_id = c.id) = 2
            LIMIT 1
          `;
          if (existing.length) {
            const chat = await s`SELECT id, name, type, created_at FROM internal_chats WHERE id = ${existing[0].id}`;
            return Response.json({ chat: chat[0], reused: true });
          }
        }

        const finalTitle = title?.trim() || (type === "direct" ? "Conversa direta" : "Grupo");
        const inserted = await s`
          INSERT INTO internal_chats (tenant_id, name, type, created_by)
          VALUES (${tenantId}, ${finalTitle}, ${type}, ${uid})
          RETURNING id, name, type, created_at
        `;
        const chat = inserted[0];

        // Inserir membros (ON CONFLICT evita duplicidade)
        const values = allMembers.map((u) => ({ chat_id: chat.id, user_id: u }));
        await s`
          INSERT INTO internal_chat_members ${s(values, "chat_id", "user_id")}
          ON CONFLICT DO NOTHING
        `;

        return Response.json({ chat, reused: false });
      },
    },
  },
});
