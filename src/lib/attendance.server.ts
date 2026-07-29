/**
 * Atribuição de atendimento por conversa (assume / transfer).
 * Usa public.conversation_assignments + public.attendance_notifications.
 */
import { sql } from "@/lib/pg.server";
import { requireCompanyId, getCurrentUserCompanyInfo } from "@/lib/company.server";
import { getSessionUserId } from "@/lib/session.server";
import {
  onCampaignAssume,
  onCampaignFinish,
  onCampaignReopen,
} from "@/lib/campaign-service-status.server";

export type AssignmentResult = {
  conversationId: string;
  assigned_user_id: string;
  assigned_user_name: string;
  assigned_user_email: string | null;
  assigned_at: string;
  assigned_by: string | null;
};

const MANAGER_ROLES = new Set([
  "ADMIN_EMPRESA",
  "GERENTE",
  "SUPERVISOR",
  "TI",
  "SUPER_ADMIN",
  "ADMIN_GERAL",
]);

const ATTENDANT_ROLES = new Set(["ATENDENTE", "ATENDENTE_GERAL"]);

function normalizeRole(role: string | null | undefined): string {
  return String(role ?? "").toUpperCase();
}

export function canAssumeAttendance(role: string | null | undefined): boolean {
  const r = normalizeRole(role);
  return ATTENDANT_ROLES.has(r) || MANAGER_ROLES.has(r);
}

export function canTransferAny(role: string | null | undefined): boolean {
  return MANAGER_ROLES.has(normalizeRole(role));
}

export function canTransferConversation(
  role: string | null | undefined,
  actorUserId: string,
  currentAssigneeId: string | null,
): boolean {
  if (canTransferAny(role)) return true;
  const r = normalizeRole(role);
  if (!ATTENDANT_ROLES.has(r)) return false;
  // ATENDENTE / ATENDENTE_GERAL: só sem responsável ou atribuída a si.
  return !currentAssigneeId || currentAssigneeId === actorUserId;
}

export async function requireAttendanceActor(): Promise<
  | { userId: string; companyId: string; role: string; name: string }
  | Response
> {
  const company = await requireCompanyId();
  if (company instanceof Response) return company;

  let uid = getSessionUserId();
  if (!uid) {
    const info = await getCurrentUserCompanyInfo();
    uid = info.userId;
  }
  if (!uid) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const info = await getCurrentUserCompanyInfo(uid);
  const role = info.role ?? "";
  if (!role) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const s = sql();
  const rows = await s<{ name: string | null; email: string | null; active: boolean | null }[]>`
    SELECT name, email, active FROM public.users
    WHERE id = ${uid}::uuid
    LIMIT 1
  `;
  if (!rows[0] || rows[0].active === false) {
    return Response.json({ error: "user_inactive" }, { status: 403 });
  }

  return {
    userId: uid,
    companyId: company,
    role,
    name: rows[0].name || rows[0].email || "Atendente",
  };
}

async function getActiveAssignee(
  db: ReturnType<typeof sql>,
  conversationId: string,
): Promise<string | null> {
  const rows = await db<{ user_id: string }[]>`
    SELECT user_id FROM public.conversation_assignments
    WHERE conversation_id = ${conversationId}::uuid
      AND active = true
      AND unassigned_at IS NULL
    LIMIT 1
  `;
  return rows[0]?.user_id ?? null;
}

async function loadUserInCompany(
  db: ReturnType<typeof sql>,
  userId: string,
  companyId: string,
): Promise<{ id: string; name: string; email: string | null } | null> {
  const rows = await db<{ id: string; name: string | null; email: string | null }[]>`
    SELECT id, name, email FROM public.users
    WHERE id = ${userId}::uuid
      AND company_id = ${companyId}::uuid
      AND COALESCE(active, true) = true
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    name: rows[0].name || rows[0].email || "Atendente",
    email: rows[0].email,
  };
}

/**
 * Desativa assignment ativo e cria um novo para `toUserId`.
 * Deve rodar dentro de transação (db = client da transação).
 */
async function replaceAssignment(
  db: ReturnType<typeof sql>,
  opts: {
    companyId: string;
    conversationId: string;
    toUserId: string;
    assignedBy: string;
  },
): Promise<{ assigned_at: string }> {
  await db`
    UPDATE public.conversation_assignments
    SET active = false, unassigned_at = now()
    WHERE conversation_id = ${opts.conversationId}::uuid
      AND active = true
      AND unassigned_at IS NULL
  `;

  const inserted = await db<{ assigned_at: Date }[]>`
    INSERT INTO public.conversation_assignments
      (company_id, conversation_id, user_id, assigned_by, active)
    VALUES
      (${opts.companyId}::uuid, ${opts.conversationId}::uuid,
       ${opts.toUserId}::uuid, ${opts.assignedBy}::uuid, true)
    RETURNING assigned_at
  `;

  return { assigned_at: new Date(inserted[0].assigned_at).toISOString() };
}

export async function assumeConversation(
  conversationId: string,
): Promise<AssignmentResult | Response> {
  const actor = await requireAttendanceActor();
  if (actor instanceof Response) return actor;

  if (!canAssumeAttendance(actor.role)) {
    return Response.json(
      { error: "forbidden", message: "Seu perfil não pode assumir atendimento." },
      { status: 403 },
    );
  }

  const s = sql();
  const owns = await s`
    SELECT id FROM public.conversations
    WHERE id = ${conversationId}::uuid AND company_id = ${actor.companyId}::uuid
    LIMIT 1
  `;
  if (!owns[0]) return Response.json({ error: "not_found" }, { status: 404 });

  // Ator já passou por requireCompanyId (empresa operacional válida).
  const meRows = await s<{ id: string; name: string | null; email: string | null }[]>`
    SELECT id, name, email FROM public.users
    WHERE id = ${actor.userId}::uuid AND COALESCE(active, true) = true
    LIMIT 1
  `;
  if (!meRows[0]) {
    return Response.json(
      { error: "forbidden", message: "Usuário inativo ou não encontrado." },
      { status: 403 },
    );
  }
  const me = {
    id: meRows[0].id,
    name: meRows[0].name || meRows[0].email || actor.name,
    email: meRows[0].email,
  };

  const result = await s.begin(async (tx) => {
    const locked = await tx<{ id: string }[]>`
      SELECT id FROM public.conversations
      WHERE id = ${conversationId}::uuid
        AND company_id = ${actor.companyId}::uuid
      FOR UPDATE
    `;
    if (!locked[0]) {
      throw new Error("not_found");
    }

    const existingAssignee = await tx<
      { user_id: string; name: string | null; email: string | null }[]
    >`
      SELECT a.user_id, u.name, u.email
      FROM public.conversation_assignments a
      JOIN public.users u ON u.id = a.user_id
      WHERE a.conversation_id = ${conversationId}::uuid
        AND a.active = true
        AND a.unassigned_at IS NULL
      LIMIT 1
    `;
    const other = existingAssignee[0];
    if (other && other.user_id !== actor.userId) {
      const conflictName = other.name || other.email || "Outro atendente";
      return {
        conflict: true as const,
        assigned_user_name: conflictName,
      };
    }

    const { assigned_at } = await replaceAssignment(tx as unknown as ReturnType<typeof sql>, {
      companyId: actor.companyId,
      conversationId,
      toUserId: actor.userId,
      assignedBy: actor.userId,
    });

    await tx`
      UPDATE public.conversations
      SET status = CASE WHEN status = 'waiting' THEN 'open' ELSE status END,
          updated_at = now()
      WHERE id = ${conversationId}::uuid
    `;

    await onCampaignAssume({
      companyId: actor.companyId,
      conversationId,
    });

    return {
      conflict: false as const,
      conversationId,
      assigned_user_id: me.id,
      assigned_user_name: me.name,
      assigned_user_email: me.email,
      assigned_at,
      assigned_by: actor.userId,
    };
  });

  if ("conflict" in result && result.conflict) {
    return Response.json(
      {
        error: "already_assigned",
        message: `Esta conversa já foi assumida por ${result.assigned_user_name}.`,
        assigned_user_name: result.assigned_user_name,
      },
      { status: 409 },
    );
  }

  return result as AssignmentResult;
}

export async function transferConversation(
  conversationId: string,
  toUserId: string,
): Promise<AssignmentResult | Response> {
  const actor = await requireAttendanceActor();
  if (actor instanceof Response) return actor;

  const s = sql();
  const owns = await s`
    SELECT id FROM public.conversations
    WHERE id = ${conversationId}::uuid AND company_id = ${actor.companyId}::uuid
    LIMIT 1
  `;
  if (!owns[0]) return Response.json({ error: "not_found" }, { status: 404 });

  const currentAssignee = await getActiveAssignee(s, conversationId);
  if (!canTransferConversation(actor.role, actor.userId, currentAssignee)) {
    return Response.json(
      {
        error: "forbidden",
        message:
          "Você só pode transferir conversas sem responsável ou atribuídas a você.",
      },
      { status: 403 },
    );
  }

  const target = await loadUserInCompany(s, toUserId, actor.companyId);
  if (!target) {
    return Response.json(
      { error: "invalid_target", message: "Atendente destino inválido ou inativo." },
      { status: 400 },
    );
  }

  const systemText = `Atendimento transferido para ${target.name}`;

  const result = await s.begin(async (tx) => {
    const { assigned_at } = await replaceAssignment(tx as unknown as ReturnType<typeof sql>, {
      companyId: actor.companyId,
      conversationId,
      toUserId: target.id,
      assignedBy: actor.userId,
    });

    await tx`
      UPDATE public.conversations
      SET status = CASE WHEN status = 'waiting' THEN 'open' ELSE status END,
          last_message = ${systemText},
          last_message_at = now(),
          updated_at = now()
      WHERE id = ${conversationId}::uuid
    `;

    // Mensagem/evento de sistema na conversa (visível no chat).
    await tx`
      INSERT INTO public.messages (
        conversation_id, direction, message_type, message_text, from_me, status
      ) VALUES (
        ${conversationId}::uuid, 'system', 'system', ${systemText}, false, 'received'
      )
    `;

    // Notificação para o destino (não notifica se transferir para si mesmo).
    if (target.id !== actor.userId) {
      await tx`
        INSERT INTO public.attendance_notifications (
          company_id, user_id, conversation_id, type, title, body, from_user_id
        ) VALUES (
          ${actor.companyId}::uuid,
          ${target.id}::uuid,
          ${conversationId}::uuid,
          'transfer',
          'Você recebeu um atendimento',
          ${`${actor.name} transferiu um atendimento para você.`},
          ${actor.userId}::uuid
        )
      `;
    }

    return {
      conversationId,
      assigned_user_id: target.id,
      assigned_user_name: target.name,
      assigned_user_email: target.email,
      assigned_at,
      assigned_by: actor.userId,
    } satisfies AssignmentResult;
  });

  return result;
}

export async function finishConversation(
  conversationId: string,
): Promise<{ ok: true; status: string; campaign_service_status: string | null } | Response> {
  const actor = await requireAttendanceActor();
  if (actor instanceof Response) return actor;

  if (!canAssumeAttendance(actor.role)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const s = sql();
  const owns = await s`
    SELECT id FROM public.conversations
    WHERE id = ${conversationId}::uuid AND company_id = ${actor.companyId}::uuid
    LIMIT 1
  `;
  if (!owns[0]) return Response.json({ error: "not_found" }, { status: 404 });

  await onCampaignFinish({ companyId: actor.companyId, conversationId });

  const rows = await s<{ status: string; campaign_service_status: string | null }[]>`
    SELECT status, campaign_service_status FROM public.conversations
    WHERE id = ${conversationId}::uuid
    LIMIT 1
  `;
  return {
    ok: true,
    status: rows[0]?.status ?? "finished",
    campaign_service_status: rows[0]?.campaign_service_status ?? null,
  };
}

export async function reopenConversation(
  conversationId: string,
): Promise<
  | { ok: true; status: string; campaign_service_status: string | null }
  | Response
> {
  const actor = await requireAttendanceActor();
  if (actor instanceof Response) return actor;

  if (!canAssumeAttendance(actor.role)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const s = sql();
  const owns = await s`
    SELECT id FROM public.conversations
    WHERE id = ${conversationId}::uuid AND company_id = ${actor.companyId}::uuid
    LIMIT 1
  `;
  if (!owns[0]) return Response.json({ error: "not_found" }, { status: 404 });

  try {
    const result = await onCampaignReopen({
      companyId: actor.companyId,
      conversationId,
    });
    return {
      ok: true,
      status: result.status,
      campaign_service_status: result.campaign_service_status,
    };
  } catch {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
