// GET /api/dashboard — indicadores operacionais de atendimento (por company_id).
// Managers veem a empresa inteira; atendentes veem principalmente os seus + sem responsável.
import { createFileRoute } from "@tanstack/react-router";
import { sql, ensureCrmSchema, ensureAttendanceSchema } from "@/lib/pg.server";
import {
  requireAttendanceActor,
  canTransferAny,
} from "@/lib/attendance.server";

export const Route = createFileRoute("/api/dashboard")({
  server: {
    handlers: {
      GET: async () => {
        await ensureCrmSchema();
        await ensureAttendanceSchema();

        const actor = await requireAttendanceActor();
        if (actor instanceof Response) return actor;

        const companyId = actor.companyId;
        const userId = actor.userId;
        const isManager = canTransferAny(actor.role);
        const s = sql();

        const toIso = (v: unknown): string | null => {
          if (v == null) return null;
          if (v instanceof Date) return v.toISOString();
          const s = String(v);
          return s || null;
        };

        // Base: conversas da empresa (exclui merged/archived).
        // last_dir: direção da última mensagem não-sistema (in/out).
        const baseRaw = await s<Record<string, unknown>[]>`
          SELECT
            c.id,
            c.status,
            c.last_message,
            c.last_message_at,
            c.created_at,
            c.updated_at,
            c.contact_id,
            ct.name AS contact_name,
            ct.phone,
            c.whatsapp_channel_id,
            ch.name AS channel_name,
            ch.evolution_instance_name,
            ch.status AS channel_status,
            a.user_id AS assigned_user_id,
            au.name AS assigned_user_name,
            au.email AS assigned_user_email,
            lm.direction AS last_dir,
            lm.from_me AS last_from_me
          FROM public.conversations c
          JOIN public.contacts ct ON ct.id = c.contact_id
          JOIN public.whatsapp_channels ch ON ch.id = c.whatsapp_channel_id
          LEFT JOIN public.conversation_assignments a
            ON a.conversation_id = c.id
            AND a.active = true
            AND a.unassigned_at IS NULL
          LEFT JOIN public.users au ON au.id = a.user_id
          LEFT JOIN LATERAL (
            SELECT m.direction, m.from_me
            FROM public.messages m
            WHERE m.conversation_id = c.id
              AND COALESCE(m.message_type, '') IS DISTINCT FROM 'system'
              AND COALESCE(m.direction, '') IS DISTINCT FROM 'system'
            ORDER BY m.created_at DESC
            LIMIT 1
          ) lm ON true
          WHERE c.company_id = ${companyId}::uuid
            AND c.status IS DISTINCT FROM 'merged'
            AND c.status IS DISTINCT FROM 'archived'
            AND ct.status IS DISTINCT FROM 'merged'
        `;

        type BaseRow = {
          id: string;
          status: string;
          last_message: string | null;
          last_message_at: string | null;
          created_at: string;
          updated_at: string;
          contact_id: string;
          contact_name: string | null;
          phone: string | null;
          whatsapp_channel_id: string;
          channel_name: string | null;
          evolution_instance_name: string | null;
          channel_status: string | null;
          assigned_user_id: string | null;
          assigned_user_name: string | null;
          assigned_user_email: string | null;
          last_dir: string | null;
          last_from_me: boolean | null;
        };

        const base: BaseRow[] = baseRaw.map((r) => ({
          id: String(r.id),
          status: String(r.status ?? "open"),
          last_message: r.last_message != null ? String(r.last_message) : null,
          last_message_at: toIso(r.last_message_at),
          created_at: toIso(r.created_at) ?? "",
          updated_at: toIso(r.updated_at) ?? "",
          contact_id: String(r.contact_id),
          contact_name: r.contact_name != null ? String(r.contact_name) : null,
          phone: r.phone != null ? String(r.phone) : null,
          whatsapp_channel_id: String(r.whatsapp_channel_id),
          channel_name: r.channel_name != null ? String(r.channel_name) : null,
          evolution_instance_name:
            r.evolution_instance_name != null ? String(r.evolution_instance_name) : null,
          channel_status: r.channel_status != null ? String(r.channel_status) : null,
          assigned_user_id: r.assigned_user_id != null ? String(r.assigned_user_id) : null,
          assigned_user_name: r.assigned_user_name != null ? String(r.assigned_user_name) : null,
          assigned_user_email: r.assigned_user_email != null ? String(r.assigned_user_email) : null,
          last_dir: r.last_dir != null ? String(r.last_dir) : null,
          last_from_me: typeof r.last_from_me === "boolean" ? r.last_from_me : null,
        }));

        const isActive = (st: string) =>
          st !== "finished" && st !== "closed" && st !== "resolved";

        const isMine = (row: (typeof base)[0]) => row.assigned_user_id === userId;
        const isUnassigned = (row: (typeof base)[0]) => !row.assigned_user_id;

        // Escopo do atendente: próprias + sem responsável (para a maioria dos blocos).
        const inAttendantScope = (row: (typeof base)[0]) =>
          isManager || isMine(row) || isUnassigned(row);

        const scopedActive = base.filter((r) => isActive(r.status) && inAttendantScope(r));
        const allActive = base.filter((r) => isActive(r.status));
        const activeForCards = isManager ? allActive : scopedActive;

        const waitingAgent = (r: (typeof base)[0]) => {
          if (!isActive(r.status)) return false;
          // Última mensagem do cliente → aguardando atendente.
          if (r.last_from_me === false) return true;
          if (r.last_dir === "in" || r.last_dir === "inbound") return true;
          // Sem mensagem ainda e sem responsável.
          if (!r.last_dir && !r.last_from_me && isUnassigned(r)) return true;
          return false;
        };

        const waitingClient = (r: (typeof base)[0]) => {
          if (!isActive(r.status)) return false;
          if (r.last_from_me === true) return true;
          if (r.last_dir === "out" || r.last_dir === "outbound") return true;
          return false;
        };

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const todayIso = startOfToday.toISOString();

        const finishedToday = base.filter((r) => {
          const finished =
            r.status === "finished" || r.status === "closed" || r.status === "resolved";
          if (!finished) return false;
          if (!isManager && !isMine(r)) return false;
          const ts = r.updated_at || r.last_message_at;
          return ts ? new Date(ts) >= startOfToday : false;
        }).length;

        const cards = {
          open: activeForCards.length,
          unassigned: allActive.filter(isUnassigned).length,
          mine: allActive.filter(isMine).length,
          waiting_agent: activeForCards.filter(waitingAgent).length,
          waiting_client: activeForCards.filter(waitingClient).length,
          finished_today: finishedToday,
        };

        // Canais (sempre da empresa).
        const channelRows = await s<
          {
            id: string;
            name: string | null;
            evolution_instance_name: string | null;
            status: string | null;
            phone_number: string | null;
            active: boolean | null;
          }[]
        >`
          SELECT id, name, evolution_instance_name, status, phone_number, active
          FROM public.whatsapp_channels
          WHERE company_id = ${companyId}::uuid
            AND deleted_at IS NULL
          ORDER BY name ASC NULLS LAST
        `;

        const channels = {
          total: channelRows.length,
          connected: channelRows.filter((c) => String(c.status).toLowerCase() === "connected").length,
          disconnected: channelRows.filter((c) => String(c.status).toLowerCase() !== "connected").length,
          items: channelRows.map((c) => ({
            id: c.id,
            name: c.name || c.evolution_instance_name || "Canal",
            instance: c.evolution_instance_name,
            status: c.status || "disconnected",
            phone: c.phone_number,
          })),
        };

        // Por atendente (managers: todos; atendente: só ele).
        const attendantUsers = await s<
          { id: string; name: string | null; email: string | null }[]
        >`
          SELECT id, name, email FROM public.users
          WHERE company_id = ${companyId}::uuid
            AND COALESCE(active, true) = true
          ORDER BY name ASC NULLS LAST
        `;

        const byAttendant = (isManager ? attendantUsers : attendantUsers.filter((u) => u.id === userId))
          .map((u) => {
            const mineActive = allActive.filter((r) => r.assigned_user_id === u.id);
            const waitingReply = mineActive.filter(waitingAgent);
            let lastActivity: string | null = null;
            for (const r of mineActive) {
              const ts = r.last_message_at;
              if (ts && (!lastActivity || ts > lastActivity)) lastActivity = ts;
            }
            return {
              user_id: u.id,
              name: u.name || u.email || "Atendente",
              active_count: mineActive.length,
              waiting_reply_count: waitingReply.length,
              last_activity_at: lastActivity,
            };
          })
          .sort((a, b) => b.active_count - a.active_count);

        // Por canal.
        const byChannel = channelRows.map((ch) => {
          const rows = allActive.filter((r) => r.whatsapp_channel_id === ch.id);
          const scoped = isManager ? rows : rows.filter(inAttendantScope);
          let lastMessageAt: string | null = null;
          let lastMessage: string | null = null;
          for (const r of scoped) {
            if (r.last_message_at && (!lastMessageAt || r.last_message_at > lastMessageAt)) {
              lastMessageAt = r.last_message_at;
              lastMessage = r.last_message;
            }
          }
          return {
            channel_id: ch.id,
            name: ch.name || ch.evolution_instance_name || "Canal",
            open_count: scoped.length,
            unassigned_count: scoped.filter(isUnassigned).length,
            last_message: lastMessage,
            last_message_at: lastMessageAt,
          };
        });

        // Críticas.
        const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

        const toCriticalItem = (r: (typeof base)[0]) => ({
          id: r.id,
          contact_name: r.contact_name || r.phone || "Contato",
          phone: r.phone,
          channel_name: r.channel_name || r.evolution_instance_name || "Canal",
          assigned_user_id: r.assigned_user_id,
          assigned_user_name: r.assigned_user_name || r.assigned_user_email,
          is_mine: isMine(r),
          last_message: r.last_message,
          last_message_at: r.last_message_at,
          status: r.status,
        });

        const criticalUnassigned = allActive
          .filter(isUnassigned)
          .sort((a, b) => String(b.last_message_at ?? "").localeCompare(String(a.last_message_at ?? "")))
          .slice(0, 10)
          .map(toCriticalItem);

        const criticalNoReply = activeForCards
          .filter((r) => waitingAgent(r) && r.last_message_at && r.last_message_at < fifteenMinAgo)
          .sort((a, b) => String(a.last_message_at ?? "").localeCompare(String(b.last_message_at ?? "")))
          .slice(0, 10)
          .map(toCriticalItem);

        const receivedToday = activeForCards
          .filter((r) => r.created_at && r.created_at >= todayIso)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, 10)
          .map(toCriticalItem);

        const transferNotifs = await s<
          {
            id: string;
            conversation_id: string;
            title: string;
            body: string | null;
            created_at: string;
            from_user_name: string | null;
          }[]
        >`
          SELECT
            n.id, n.conversation_id, n.title, n.body, n.created_at,
            u.name AS from_user_name
          FROM public.attendance_notifications n
          LEFT JOIN public.users u ON u.id = n.from_user_id
          WHERE n.user_id = ${userId}::uuid
            AND n.company_id = ${companyId}::uuid
            AND n.read_at IS NULL
            AND n.type = 'transfer'
          ORDER BY n.created_at DESC
          LIMIT 20
        `;

        const transferredToMe = transferNotifs.map((n) => {
          const conv = base.find((b) => b.id === n.conversation_id);
          return {
            notification_id: String(n.id),
            conversation_id: String(n.conversation_id),
            title: n.title,
            body: n.body,
            from_user_name: n.from_user_name,
            created_at: toIso(n.created_at) ?? "",
            contact_name: conv?.contact_name ?? null,
            phone: conv?.phone ?? null,
            channel_name: conv?.channel_name ?? null,
          };
        });

        // Últimas conversas.
        const recentSource = isManager ? allActive : scopedActive;
        const recent = [...recentSource]
          .sort((a, b) =>
            String(b.last_message_at ?? b.created_at).localeCompare(
              String(a.last_message_at ?? a.created_at),
            ),
          )
          .slice(0, 15)
          .map((r) => ({
            id: r.id,
            contact_name: r.contact_name || r.phone || "Contato",
            phone: r.phone,
            channel_name: r.channel_name || r.evolution_instance_name || "Canal",
            channel_id: r.whatsapp_channel_id,
            assigned_user_id: r.assigned_user_id,
            assigned_user_name: r.assigned_user_name || r.assigned_user_email,
            is_mine: isMine(r),
            last_message: r.last_message,
            last_message_at: r.last_message_at,
            status: r.status,
          }));

        return Response.json({
          scope: isManager ? "company" : "attendant",
          role: actor.role,
          cards,
          channels,
          by_attendant: byAttendant,
          by_channel: byChannel,
          critical: {
            unassigned: criticalUnassigned,
            no_reply_15m: criticalNoReply,
            received_today: receivedToday,
            transferred_to_me: transferredToMe,
          },
          recent,
          generated_at: new Date().toISOString(),
        });
      },
    },
  },
});
