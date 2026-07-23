// Conexão PostgreSQL externa via DATABASE_URL.
// Usa postgres.js. Servidor-only.
import postgres from "postgres";
import { normalizePhoneForMatch } from "@/lib/phone";

let _sql: ReturnType<typeof postgres> | null = null;
let _schemaReady: Promise<void> | null = null;

/** Cliente postgres.js. Use `sql()`…` ou `const s = sql(); s`…``. */
export function sql(strings?: TemplateStringsArray, ...values: unknown[]) {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL não configurada");
    _sql = postgres(url, {
      ssl:
        url.includes("sslmode=require") || url.includes("supabase") || url.includes("neon")
          ? "require"
          : undefined,
      max: 5,
      prepare: false,
    });
  }
  // Chamada como tagged template: sql`SELECT …`
  if (strings && Array.isArray(strings) && "raw" in strings) {
    return (_sql as (...args: unknown[]) => unknown)(strings, ...values);
  }
  // Chamada normal: const s = sql(); await s`SELECT …`
  return _sql;
}

// ───────────────────────────────────────────────────────────────────────────
// Schema de Atendimento/CRM (Evolution) — banco principal (nexaboot-postgres).
// Idempotente e NÃO destrutivo: só CREATE TABLE/INDEX IF NOT EXISTS e
// ADD COLUMN IF NOT EXISTS. Não apaga nada, não usa Supabase/RLS.
// Padrão com company_id, conforme o código do webhook/atendimento espera.
// ───────────────────────────────────────────────────────────────────────────
let _crmReady: Promise<void> | null = null;

/**
 * Substitui ON DELETE CASCADE por ON DELETE RESTRICT entre
 * contacts → conversations → messages, SEM jamais apagar dados.
 *
 * Passo defensivo para bancos legados: antes de validar cada FET RESTRICT,
 * trata registros órfãos apenas DESVINCULANDO com NULL (preserva histórico):
 *   - conversations.contact_id órfão  → NULL  (conversa e mensagens mantidas)
 *   - messages.conversation_id órfão  → NULL  (mensagem mantida) — só se a
 *     coluna for nullable. Se for NOT NULL e houver órfãs, NÃO altera (não
 *     apaga, não quebra) e registra log claro para a TI corrigir no banco.
 * Nunca usa DELETE.
 */
async function ensureNoCascadeFks(s: ReturnType<typeof sql>) {
  // ── 1) conversations.contact_id ───────────────────────────────────────────
  const orphanConvs = await s<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM public.conversations c
    WHERE c.contact_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = c.contact_id)
  `;
  const orphanConvCount = Number(orphanConvs[0]?.count ?? 0);
  if (orphanConvCount > 0) {
    console.warn("[CRM_ORPHAN_CONVERSATIONS]", {
      count: orphanConvCount,
      action: "SET contact_id = NULL (conversa e mensagens preservadas; nada apagado)",
    });
    await s`
      UPDATE public.conversations c
      SET contact_id = NULL, updated_at = now()
      WHERE c.contact_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.contacts ct WHERE ct.id = c.contact_id)
    `;
  }
  await s.unsafe(`
    ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_contact_id_fkey;
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_contact_id_fkey
      FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;
  `);
  console.log("[CRM_FK_RESTRICT_OK]", {
    fk: "conversations.contact_id",
    orphansUnlinked: orphanConvCount,
  });

  // ── 2) messages.conversation_id ───────────────────────────────────────────
  const col = await s<{ is_nullable: string }[]>`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'conversation_id'
    LIMIT 1
  `;
  const conversationIdNullable = col[0]?.is_nullable === "YES";

  const orphanMsgs = await s<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM public.messages m
    WHERE m.conversation_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = m.conversation_id)
  `;
  const orphanMsgCount = Number(orphanMsgs[0]?.count ?? 0);

  if (orphanMsgCount > 0 && !conversationIdNullable) {
    // Não apagamos mensagens e não podemos setar NULL → não aplicamos a FK.
    console.error("[CRM_ORPHAN_MESSAGES_BLOCKED]", {
      count: orphanMsgCount,
      reason: "messages.conversation_id é NOT NULL e existem mensagens órfãs.",
      action: "RESTRICT NÃO aplicado (não apaga, não quebra). TI deve corrigir os órfãos no banco.",
    });
    return;
  }

  if (orphanMsgCount > 0) {
    console.warn("[CRM_ORPHAN_MESSAGES]", {
      count: orphanMsgCount,
      action: "SET conversation_id = NULL (mensagem preservada; nada apagado)",
    });
    await s`
      UPDATE public.messages m
      SET conversation_id = NULL
      WHERE m.conversation_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = m.conversation_id)
    `;
  }
  await s.unsafe(`
    ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_conversation_id_fkey;
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_conversation_id_fkey
      FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE RESTRICT;
  `);
  console.log("[CRM_FK_RESTRICT_OK]", {
    fk: "messages.conversation_id",
    orphansUnlinked: orphanMsgCount,
  });
}

/**
 * Garante telefone ÚNICO por empresa entre contatos ATIVOS, tratando duplicados
 * legados SEM apagar dados. A unicidade/dedup usa phone_match (chave canônica
 * que ignora o nono dígito de celulares BR). Passos (idempotente):
 *   1) backfill de name_source (heurístico: placeholder → 'auto', senão 'manual');
 *   2) remove índices únicos antigos (por phone) para poder canonicalizar/mesclar;
 *   3) normaliza telefones legados in-place (só dígitos) — canonicalização, não
 *      destrutivo (external_jid permanece intacto);
 *   4) backfill de phone_match (forma canônica sem o 9) e índice de apoio;
 *   5) mescla duplicados ativos por (company_id, phone_match): escolhe principal
 *      (preferindo name_source='manual', depois mais antigo), migra
 *      conversations.contact_id para o principal e marca os demais como 'merged'
 *      (nunca DELETE; mensagens preservadas);
 *   6) cria índice único PARCIAL por (company_id, phone_match) entre ativos.
 */
async function ensureContactsDedup(s: ReturnType<typeof sql>) {
  // 1) Backfill de name_source quando ausente.
  await s`
    UPDATE public.contacts
    SET name_source = CASE
      WHEN name IS NULL OR btrim(name) = '' OR name = phone THEN 'auto'
      ELSE 'manual'
    END
    WHERE name_source IS NULL
  `;

  // 2) Remove índices únicos antigos (por phone), se existirem.
  await s.unsafe(`DROP INDEX IF EXISTS contacts_company_phone_uniq;`);
  await s.unsafe(`DROP INDEX IF EXISTS contacts_company_phone_active_uniq;`);

  // 3) Canonicaliza telefones legados para apenas dígitos.
  const normed = await s<{ id: string }[]>`
    UPDATE public.contacts
    SET phone = regexp_replace(coalesce(phone, ''), '\\D', '', 'g'),
        updated_at = now()
    WHERE phone IS DISTINCT FROM regexp_replace(coalesce(phone, ''), '\\D', '', 'g')
    RETURNING id
  `;
  if (normed.length > 0) {
    console.log("[CONTACTS_PHONE_NORMALIZED]", { updated: normed.length });
  }

  // 4) Backfill de phone_match (forma canônica: remove o 9 de celular BR de 13
  //    dígitos quando o dígito após o DDD é '9'). Idempotente.
  await s.unsafe(`
    UPDATE public.contacts
    SET phone_match = CASE
      WHEN phone ~ '^55' AND length(phone) = 13 AND substring(phone from 5 for 1) = '9'
        THEN substring(phone from 1 for 4) || substring(phone from 6)
      ELSE phone
    END
    WHERE phone_match IS DISTINCT FROM CASE
      WHEN phone ~ '^55' AND length(phone) = 13 AND substring(phone from 5 for 1) = '9'
        THEN substring(phone from 1 for 4) || substring(phone from 6)
      ELSE phone
    END;
  `);
  await s.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_contacts_company_phonematch
      ON public.contacts(company_id, phone_match);
  `);

  // 5) Mescla duplicados ATIVOS por (company_id, phone_match) — trata as
  //    variantes com/sem nono dígito como o MESMO contato.
  const dupGroups = await s<{ company_id: string; phone_match: string }[]>`
    SELECT company_id, phone_match
    FROM public.contacts
    WHERE phone_match IS NOT NULL AND btrim(phone_match) <> ''
      AND status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo'
    GROUP BY company_id, phone_match
    HAVING count(*) > 1
  `;
  for (const g of dupGroups) {
    const rows = await s<{ id: string; name: string | null; name_source: string | null }[]>`
      SELECT id, name, name_source
      FROM public.contacts
      WHERE company_id = ${g.company_id}::uuid AND phone_match = ${g.phone_match}
        AND status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo'
      ORDER BY (name_source = 'manual') DESC, created_at ASC
    `;
    const principal = rows[0];
    const others = rows.slice(1);
    for (const o of others) {
      const moved = await s<{ id: string }[]>`
        UPDATE public.conversations
        SET contact_id = ${principal.id}::uuid, updated_at = now()
        WHERE contact_id = ${o.id}::uuid
        RETURNING id
      `;
      await s`
        UPDATE public.contacts
        SET status = 'merged', updated_at = now()
        WHERE id = ${o.id}::uuid
      `;
      console.warn("[CONTACTS_DEDUP_MERGED]", {
        companyId: g.company_id,
        phoneMatch: g.phone_match,
        principal: principal.id,
        merged: o.id,
        conversationsMoved: moved.length,
      });
    }
  }

  // 6) Índice único PARCIAL: telefone canônico único entre contatos ATIVOS
  //    (ignora vazio e contatos merged/inativos).
  await s.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_phonematch_active_uniq
      ON public.contacts(company_id, phone_match)
      WHERE phone_match IS NOT NULL AND btrim(phone_match) <> ''
        AND status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo';
  `);
  console.log("[CONTACTS_UNIQUE_INDEX_OK]", {
    index: "contacts_company_phonematch_active_uniq",
    dupGroups: dupGroups.length,
  });
}

/**
 * Consolida conversas duplicadas SEM apagar nada. Para cada
 * (company_id, contact_id, whatsapp_channel_id) com mais de uma conversa:
 *   - escolhe a principal (prefere 'open', depois a mais recente);
 *   - migra as mensagens das duplicadas para a principal (preservando histórico;
 *     mensagens com external_message_id já presente na principal permanecem na
 *     conversa de origem para não violar a unicidade — nada é apagado);
 *   - marca as duplicadas como status='merged';
 *   - recalcula última mensagem/horário da principal.
 * Deve rodar DEPOIS de ensureContactsDedup (que já aponta contact_id ao principal).
 */
async function ensureConversationsDedup(s: ReturnType<typeof sql>) {
  // Passo 0: revincular conversas SEM contact_id usando o remoteJid da última
  // mensagem (normalizado) → contato principal por (company_id, phone).
  const orphanConvs = await s<{ id: string; company_id: string; remote_jid: string | null }[]>`
    SELECT c.id, c.company_id, COALESCE(
      m.remote_jid_a, m.remote_jid_b, m.remote_jid_c
    ) AS remote_jid
    FROM public.conversations c
    JOIN LATERAL (
      SELECT
        raw_payload #>> '{data,key,remoteJid}'   AS remote_jid_a,
        raw_payload #>> '{data,0,key,remoteJid}' AS remote_jid_b,
        raw_payload #>> '{key,remoteJid}'        AS remote_jid_c
      FROM public.messages
      WHERE conversation_id = c.id AND raw_payload IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    ) m ON true
    WHERE c.contact_id IS NULL
      AND c.status IS DISTINCT FROM 'merged' AND c.status IS DISTINCT FROM 'archived'
  `;
  for (const oc of orphanConvs) {
    const phoneMatch = normalizePhoneForMatch(oc.remote_jid);
    if (!phoneMatch) continue;
    const ct = await s<{ id: string }[]>`
      SELECT id FROM public.contacts
      WHERE company_id = ${oc.company_id}::uuid AND phone_match = ${phoneMatch}
        AND status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'inativo'
      ORDER BY (name_source = 'manual') DESC, created_at ASC
      LIMIT 1
    `;
    if (ct[0]) {
      await s`
        UPDATE public.conversations
        SET contact_id = ${ct[0].id}::uuid, updated_at = now()
        WHERE id = ${oc.id}::uuid
      `;
      console.warn("[CONVERSATION_RELINKED]", { conversation: oc.id, phone, contact: ct[0].id });
    }
  }

  const dupGroups = await s<
    { company_id: string; contact_id: string; whatsapp_channel_id: string }[]
  >`
    SELECT company_id, contact_id, whatsapp_channel_id
    FROM public.conversations
    WHERE contact_id IS NOT NULL
      AND status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'archived'
    GROUP BY company_id, contact_id, whatsapp_channel_id
    HAVING count(*) > 1
  `;
  for (const g of dupGroups) {
    const rows = await s<{ id: string }[]>`
      SELECT id
      FROM public.conversations
      WHERE company_id = ${g.company_id}::uuid
        AND contact_id = ${g.contact_id}::uuid
        AND whatsapp_channel_id = ${g.whatsapp_channel_id}::uuid
        AND status IS DISTINCT FROM 'merged' AND status IS DISTINCT FROM 'archived'
      ORDER BY (status = 'open') DESC, last_message_at DESC NULLS LAST, created_at DESC
    `;
    const principal = rows[0];
    const others = rows.slice(1);
    for (const o of others) {
      // Migra mensagens, evitando colisão de external_message_id na principal.
      const movedMsgs = await s<{ id: string }[]>`
        UPDATE public.messages m
        SET conversation_id = ${principal.id}::uuid
        WHERE m.conversation_id = ${o.id}::uuid
          AND (
            m.external_message_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.messages p
              WHERE p.conversation_id = ${principal.id}::uuid
                AND p.external_message_id = m.external_message_id
            )
          )
        RETURNING m.id
      `;
      await s`
        UPDATE public.conversations
        SET status = 'merged', updated_at = now()
        WHERE id = ${o.id}::uuid
      `;
      console.warn("[CONVERSATIONS_DEDUP_MERGED]", {
        companyId: g.company_id,
        contactId: g.contact_id,
        channelId: g.whatsapp_channel_id,
        principal: principal.id,
        merged: o.id,
        messagesMoved: movedMsgs.length,
      });
    }
    // Recalcula última mensagem/horário da principal a partir das mensagens.
    await s`
      UPDATE public.conversations c
      SET last_message_at = sub.max_at,
          last_message = COALESCE(sub.last_text, c.last_message),
          updated_at = now()
      FROM (
        SELECT
          max(created_at) AS max_at,
          (SELECT message_text FROM public.messages
            WHERE conversation_id = ${principal.id}::uuid
            ORDER BY created_at DESC LIMIT 1) AS last_text
        FROM public.messages
        WHERE conversation_id = ${principal.id}::uuid
      ) sub
      WHERE c.id = ${principal.id}::uuid
    `;
  }
  console.log("[CONVERSATIONS_DEDUP_OK]", { dupGroups: dupGroups.length });
}

export async function ensureCrmSchema() {
  if (_crmReady) return _crmReady;
  _crmReady = (async () => {
    const s = sql();
    try {
      await s.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS public.companies (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS public.whatsapp_channels (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
          name TEXT,
          channel_type TEXT NOT NULL DEFAULT 'evolution',
          evolution_instance_name TEXT,
          status TEXT NOT NULL DEFAULT 'disconnected',
          last_connected_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_channels_type_instance
          ON public.whatsapp_channels(channel_type, evolution_instance_name);

        -- Colunas extras para a tela de gestão de canais (idempotente).
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS phone_number TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS display_name TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

        -- Meta WhatsApp Cloud API (campos operacionais por canal; tokens ficam em whatsapp_channel_secrets).
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS waba_id TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS phone_number_id TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS business_id TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS display_phone_number TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS token_status TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS webhook_verify_token TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS last_error_code TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS last_error_message TEXT;
        ALTER TABLE public.whatsapp_channels ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_meta_phone_number_id
          ON public.whatsapp_channels(phone_number_id)
          WHERE phone_number_id IS NOT NULL AND deleted_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_channels_meta_waba
          ON public.whatsapp_channels(waba_id)
          WHERE channel_type = 'meta';

        CREATE INDEX IF NOT EXISTS idx_channels_company_type
          ON public.whatsapp_channels(company_id, channel_type);

        CREATE TABLE IF NOT EXISTS public.whatsapp_channel_secrets (
          channel_id UUID PRIMARY KEY REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
          access_token_ciphertext TEXT,
          token_updated_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS public.meta_webhook_event_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
          channel_id UUID REFERENCES public.whatsapp_channels(id) ON DELETE SET NULL,
          phone_number_id TEXT,
          event_type TEXT,
          signature_valid BOOLEAN NOT NULL DEFAULT false,
          processing_status TEXT NOT NULL DEFAULT 'received',
          http_status INT,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS idx_meta_webhook_logs_company
          ON public.meta_webhook_event_logs(company_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_meta_webhook_logs_channel
          ON public.meta_webhook_event_logs(channel_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS public.contacts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
          phone TEXT NOT NULL,
          name TEXT,
          external_jid TEXT,
          contact_type TEXT NOT NULL DEFAULT 'individual',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- Índice de busca por (company_id, phone). O índice ÚNICO de telefone é
        -- aplicado em ensureContactsDedup() (parcial, só contatos ativos), depois
        -- de tratar/mesclar duplicados legados sem apagar nada.
        CREATE INDEX IF NOT EXISTS idx_contacts_company_phone
          ON public.contacts(company_id, phone);

        -- Colunas extras para a tela de Contatos (idempotente, não destrutivo).
        -- O webhook continua gravando só company_id/phone/name/external_jid/contact_type;
        -- estas colunas são opcionais e usadas pelo CRUD manual da tela /contatos.
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS email TEXT;
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS reference TEXT;
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS status TEXT;
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS tags TEXT[];
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS avatar_color TEXT;
        -- Origem do nome: 'manual' (tela /contatos) nunca é sobrescrito pelo
        -- pushName do WhatsApp; 'whatsapp'/'auto' podem ser atualizados.
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS name_source TEXT;
        -- Chave canônica de telefone (sem o nono dígito BR) usada para
        -- unicidade/deduplicação tolerante a variantes com/sem o 9.
        ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS phone_match TEXT;

        CREATE TABLE IF NOT EXISTS public.conversations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
          -- Regra NexaBoot: contato NUNCA apaga conversas em cascata (RESTRICT).
          contact_id UUID REFERENCES public.contacts(id) ON DELETE RESTRICT,
          whatsapp_channel_id UUID REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'open',
          unread_count INTEGER NOT NULL DEFAULT 0,
          last_message TEXT,
          last_message_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_company ON public.conversations(company_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_contact ON public.conversations(contact_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_channel ON public.conversations(whatsapp_channel_id);

        CREATE TABLE IF NOT EXISTS public.messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          -- Regra NexaBoot: conversa NUNCA apaga mensagens em cascata (RESTRICT).
          conversation_id UUID REFERENCES public.conversations(id) ON DELETE RESTRICT,
          external_id TEXT,
          external_message_id TEXT,
          direction TEXT,
          message_type TEXT,
          message_text TEXT,
          from_me BOOLEAN NOT NULL DEFAULT false,
          raw_payload JSONB,
          media_type TEXT,
          media_mimetype TEXT,
          mime_type TEXT,
          media_filename TEXT,
          media_caption TEXT,
          media_base64 TEXT,
          media_error TEXT,
          media_url TEXT,
          media_seconds INTEGER,
          status TEXT NOT NULL DEFAULT 'received',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_messages_external_id ON public.messages(external_id);
        CREATE INDEX IF NOT EXISTS idx_messages_external_message_id ON public.messages(external_message_id);
        CREATE UNIQUE INDEX IF NOT EXISTS messages_conv_extid_uniq
          ON public.messages(conversation_id, external_message_id)
          WHERE external_message_id IS NOT NULL;

        -- Autoria do atendente (Fase 2.2) e reações do WhatsApp. Idempotente e
        -- não destrutivo: mensagens antigas ficam com estes campos NULL.
        ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS sent_by_user_id UUID;
        ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS sent_by_name TEXT;
        ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reaction_emoji TEXT;
        ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reaction_to_message_id TEXT;
        -- Tamanho em bytes da mídia (envio/recebimento). Idempotente, não destrutivo.
        ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_size BIGINT;
      `);

      // ── Regra de segurança NexaBoot: proibido apagar em cascata ──
      // Troca CASCADE por RESTRICT entre contacts→conversations→messages.
      // Antes de validar cada FK, trata órfãos legados sem apagar nada
      // (apenas desvincula com NULL), evitando que o deploy quebre.
      await ensureNoCascadeFks(s);

      // Telefone único por empresa (contatos ativos) + merge defensivo de
      // duplicados legados, sem apagar nada.
      await ensureContactsDedup(s);

      // Uma conversa principal por (contato, canal). Consolida duplicadas que
      // sobraram após apontar os contatos ao principal. Não apaga nada.
      await ensureConversationsDedup(s);

      // Planos comerciais + assinaturas por empresa (fase 1 — sem enforcement).
      await ensurePlansSchema(s);

      // Campanhas (rascunhos + público; fila de envio criada mas não usada ainda).
      await ensureCampaignsSchema(s);

      // Atribuição de atendimento + notificações de transferência.
      await ensureAttendanceSchema(s);

      console.log("[CRM_SCHEMA_OK]");
    } catch (e) {
      const err = e as { message?: string; code?: string; detail?: string };
      console.error("[CRM_SCHEMA_FAIL]", {
        message: err.message,
        code: err.code,
        detail: err.detail,
      });
      _crmReady = null; // permite nova tentativa
      throw e;
    }
  })();
  return _crmReady;
}

// ───────────────────────────────────────────────────────────────────────────
// Planos comerciais e assinaturas (company_subscriptions).
// Idempotente, não destrutivo. Seed dos 5 planos iniciais por code.
// ───────────────────────────────────────────────────────────────────────────
const PLAN_SEEDS = [
  { code: "BASICO_1", name: "Plano Básico 1", max_whatsapp_channels: 1 },
  { code: "BASICO_2", name: "Plano Básico 2", max_whatsapp_channels: 2 },
  { code: "PRATA", name: "Plano Prata", max_whatsapp_channels: 5 },
  { code: "GOLD", name: "Plano Gold", max_whatsapp_channels: 10 },
  { code: "DIAMANTE", name: "Plano Diamante", max_whatsapp_channels: 20 },
] as const;

export async function ensurePlansSchema(s?: ReturnType<typeof sql>): Promise<void> {
  const db = s ?? sql();
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS public.plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      description TEXT,
      max_whatsapp_channels INT NOT NULL,
      max_users INT,
      max_messages_month INT,
      max_campaigns_month INT,
      allow_automations BOOLEAN NOT NULL DEFAULT false,
      allow_internal_chat BOOLEAN NOT NULL DEFAULT true,
      allow_api_access BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.company_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      plan_id UUID NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ends_at TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Colunas extras idempotentes (bancos legados / CREATE TABLE parcial).
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS code TEXT;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_whatsapp_channels INT;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_users INT;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_messages_month INT;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_campaigns_month INT;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS allow_automations BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS allow_internal_chat BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS allow_api_access BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
    ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
    ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    CREATE INDEX IF NOT EXISTS idx_company_subscriptions_company
      ON public.company_subscriptions (company_id);

    CREATE INDEX IF NOT EXISTS idx_company_subscriptions_plan
      ON public.company_subscriptions (plan_id);

    CREATE UNIQUE INDEX IF NOT EXISTS company_subscriptions_one_active
      ON public.company_subscriptions (company_id)
      WHERE status = 'active';
  `);

  for (const p of PLAN_SEEDS) {
    await db`
      INSERT INTO public.plans (
        name, code, description, max_whatsapp_channels,
        allow_automations, allow_internal_chat, allow_api_access, active
      )
      VALUES (
        ${p.name},
        ${p.code},
        ${`Até ${p.max_whatsapp_channels} número(s) WhatsApp`},
        ${p.max_whatsapp_channels},
        false,
        true,
        false,
        true
      )
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        max_whatsapp_channels = EXCLUDED.max_whatsapp_channels,
        updated_at = now()
    `;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Atribuição de atendimento (responsável por conversa) + notificações.
// Idempotente, não destrutivo. Um assignment ativo por conversa.
// ───────────────────────────────────────────────────────────────────────────
let _attendanceReady: Promise<void> | null = null;

export async function ensureAttendanceSchema(s?: ReturnType<typeof sql>): Promise<void> {
  if (s) {
    await applyAttendanceSchema(s);
    return;
  }
  if (_attendanceReady) return _attendanceReady;
  _attendanceReady = (async () => {
    try {
      await applyAttendanceSchema(sql());
      console.log("[ATTENDANCE_SCHEMA_OK]");
    } catch (e) {
      _attendanceReady = null;
      throw e;
    }
  })();
  return _attendanceReady;
}

async function applyAttendanceSchema(db: ReturnType<typeof sql>): Promise<void> {
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS public.conversation_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      assigned_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      unassigned_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE UNIQUE INDEX IF NOT EXISTS conversation_assignments_one_active
      ON public.conversation_assignments (conversation_id)
      WHERE active = true AND unassigned_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_conversation_assignments_company
      ON public.conversation_assignments (company_id);

    CREATE INDEX IF NOT EXISTS idx_conversation_assignments_user_active
      ON public.conversation_assignments (user_id)
      WHERE active = true AND unassigned_at IS NULL;

    CREATE TABLE IF NOT EXISTS public.attendance_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'transfer',
      title TEXT NOT NULL,
      body TEXT,
      from_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_notifications_user
      ON public.attendance_notifications (user_id, read_at, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_attendance_notifications_conversation
      ON public.attendance_notifications (conversation_id);
  `);
}

// ───────────────────────────────────────────────────────────────────────────
// Campanhas (envio em massa via Evolution — fase 1: rascunhos + público).
// Idempotente, não destrutivo. campaign_send_queue existe mas não é populada.
// ───────────────────────────────────────────────────────────────────────────
let _campaignsReady: Promise<void> | null = null;

export async function ensureCampaignsSchema(s?: ReturnType<typeof sql>): Promise<void> {
  if (_campaignsReady) return _campaignsReady;

  if (s) {
    _campaignsReady = (async () => {
      try {
        await applyCampaignsSchema(s);
        console.log("[CAMPAIGNS_SCHEMA_OK]");
      } catch (e) {
        _campaignsReady = null;
        throw e;
      }
    })();
    return _campaignsReady;
  }

  _campaignsReady = (async () => {
    try {
      await applyCampaignsSchema(sql());
      console.log("[CAMPAIGNS_SCHEMA_OK]");
    } catch (e) {
      _campaignsReady = null;
      throw e;
    }
  })();
  return _campaignsReady;
}

async function applyCampaignsSchema(db: ReturnType<typeof sql>): Promise<void> {
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS public.campaigns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      whatsapp_channel_id UUID REFERENCES public.whatsapp_channels(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      message_text TEXT,
      message_type TEXT NOT NULL DEFAULT 'text',
      status TEXT NOT NULL DEFAULT 'draft',
      scheduled_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      send_interval_ms INT NOT NULL DEFAULT 5000,
      total_contacts INT NOT NULL DEFAULT 0,
      sent_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      skipped_count INT NOT NULL DEFAULT 0,
      created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.campaign_contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
      phone TEXT NOT NULL,
      name TEXT,
      variables JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      skip_reason TEXT,
      sent_at TIMESTAMPTZ,
      provider_message_id TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.campaign_send_queue (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
      campaign_contact_id UUID NOT NULL REFERENCES public.campaign_contacts(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
      attempts INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 3,
      locked_at TIMESTAMPTZ,
      locked_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.campaign_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      campaign_contact_id UUID REFERENCES public.campaign_contacts(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_company
      ON public.campaigns (company_id);

    CREATE INDEX IF NOT EXISTS idx_campaigns_company_status
      ON public.campaigns (company_id, status);

    CREATE INDEX IF NOT EXISTS idx_campaigns_company_created
      ON public.campaigns (company_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign
      ON public.campaign_contacts (campaign_id);

    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign_status
      ON public.campaign_contacts (campaign_id, status);

    CREATE UNIQUE INDEX IF NOT EXISTS campaign_contacts_campaign_phone_uniq
      ON public.campaign_contacts (campaign_id, phone);

    CREATE INDEX IF NOT EXISTS idx_campaign_queue_campaign
      ON public.campaign_send_queue (campaign_id);

    CREATE INDEX IF NOT EXISTS idx_campaign_queue_company
      ON public.campaign_send_queue (company_id);

    CREATE INDEX IF NOT EXISTS idx_campaign_queue_pending
      ON public.campaign_send_queue (status, scheduled_for)
      WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign
      ON public.campaign_events (campaign_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_campaign_events_company
      ON public.campaign_events (company_id);

    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    -- Agenda e janela de envio (cliente configura só isso; ritmo é interno).
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS schedule_date DATE;
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS window_start_time TIME;
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS window_end_time TIME;
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'auto_safe';

    -- Variação de mensagem e motivo de skip por contato.
    ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS greeting_variant TEXT;
    ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS closing_variant TEXT;
    ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS rendered_message TEXT;
    -- Resposta do cliente ao disparo.
    ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;
    ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS response_text TEXT;
    ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS response_intent TEXT;

    -- Contadores de resposta na campanha.
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS total_replied INT NOT NULL DEFAULT 0;
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS total_interested INT NOT NULL DEFAULT 0;
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS total_opt_out INT NOT NULL DEFAULT 0;

    -- Opt-out global por empresa (impede novos disparos).
    CREATE TABLE IF NOT EXISTS public.opt_out_contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      phone_match TEXT,
      source TEXT,
      campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
      campaign_contact_id UUID REFERENCES public.campaign_contacts(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS opt_out_contacts_company_phone_uniq
      ON public.opt_out_contacts (company_id, phone);
    CREATE INDEX IF NOT EXISTS idx_opt_out_contacts_company_match
      ON public.opt_out_contacts (company_id, phone_match);

    -- Origem de resposta de campanha na conversa (atendimento).
    ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS campaign_reply_campaign_id UUID;
    ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS campaign_reply_campaign_name TEXT;
    ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS campaign_reply_text TEXT;
    ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS campaign_reply_intent TEXT;
    ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS campaign_reply_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_company_sent
      ON public.campaign_contacts (company_id, sent_at DESC)
      WHERE sent_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_campaign_contacts_company_responded
      ON public.campaign_contacts (company_id, responded_at DESC)
      WHERE responded_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_campaigns_company_active
      ON public.campaigns (company_id, created_at DESC)
      WHERE deleted_at IS NULL;

    -- Modelos de mensagem reutilizáveis por empresa.
    CREATE TABLE IF NOT EXISTS public.campaign_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      message_body TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_templates_company
      ON public.campaign_templates (company_id, active, updated_at DESC);

    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS template_id UUID;
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS source_campaign_id UUID;

    -- Templates aprovados Meta (HSM) — separados de campaign_templates (texto livre Evolution).
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS meta_template_id TEXT;
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS meta_template_name TEXT;
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS meta_language_code TEXT;
    ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS meta_variable_mappings JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS public.meta_message_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      channel_id UUID NOT NULL REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
      meta_template_id TEXT,
      template_name TEXT NOT NULL,
      language_code TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      components JSONB NOT NULL DEFAULT '[]'::jsonb,
      active BOOLEAN NOT NULL DEFAULT false,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (channel_id, template_name, language_code)
    );

    CREATE INDEX IF NOT EXISTS idx_meta_message_templates_company_channel
      ON public.meta_message_templates (company_id, channel_id, active);

    CREATE INDEX IF NOT EXISTS idx_meta_message_templates_status
      ON public.meta_message_templates (channel_id, status)
      WHERE active = true;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_template_id_fkey'
      ) THEN
        ALTER TABLE public.campaigns
          ADD CONSTRAINT campaigns_template_id_fkey
          FOREIGN KEY (template_id) REFERENCES public.campaign_templates(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_source_campaign_id_fkey'
      ) THEN
        ALTER TABLE public.campaigns
          ADD CONSTRAINT campaigns_source_campaign_id_fkey
          FOREIGN KEY (source_campaign_id) REFERENCES public.campaigns(id) ON DELETE SET NULL;
      END IF;
    END$$;
  `);
}

export async function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const s = sql();
    console.log("[SCHEMA_MIGRATION_START]");

    try {
      // 1) Extensão pgcrypto
      await s.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

      // 2) Tabela users — cria se não existir (sem destruir nada)
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS public.users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'USER',
          tenant_id TEXT NOT NULL DEFAULT 'default',
          active BOOLEAN NOT NULL DEFAULT true,
          avatar_url TEXT,
          last_login_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      // 3) Migração idempotente para bancos legados (não destrutiva)
      await s.unsafe(`
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tenant_id TEXT;
        ALTER TABLE public.users ALTER COLUMN tenant_id SET DEFAULT 'default';
        UPDATE public.users SET tenant_id = 'default' WHERE tenant_id IS NULL;
        ALTER TABLE public.users ALTER COLUMN tenant_id SET NOT NULL;

        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role TEXT;
        ALTER TABLE public.users ALTER COLUMN role SET DEFAULT 'USER';
        UPDATE public.users SET role = 'USER' WHERE role IS NULL;
        ALTER TABLE public.users ALTER COLUMN role SET NOT NULL;

        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
        UPDATE public.users SET active = true WHERE active IS NULL;
        ALTER TABLE public.users ALTER COLUMN active SET NOT NULL;

        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
        UPDATE public.users SET created_at = now() WHERE created_at IS NULL;

        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
        UPDATE public.users SET updated_at = now() WHERE updated_at IS NULL;
        ALTER TABLE public.users ALTER COLUMN updated_at SET NOT NULL;

        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS name TEXT;
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email TEXT;
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash TEXT;

        ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_email_key;

        CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_unique
          ON public.users (tenant_id, email);
        CREATE INDEX IF NOT EXISTS idx_users_tenant
          ON public.users (tenant_id);
      `);

      // 3.1) Tabela tenants (id TEXT para compatibilidade com tenant_id atual)
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS public.tenants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT UNIQUE NOT NULL,
          active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO public.tenants (id, name, slug)
          VALUES ('default', 'Default', 'default')
          ON CONFLICT (id) DO NOTHING;
      `);

      // 4) Verifica leitura das colunas esperadas
      const probe = await s`
        SELECT id, tenant_id, name, email, role, active, created_at
        FROM public.users
        LIMIT 1
      `;
      console.log("[SCHEMA_MIGRATION_OK]", {
        usersTable: "public.users",
        sampleCount: probe.length,
      });
    } catch (e) {
      const err = e as { message?: string; code?: string; detail?: string };
      console.error("[SCHEMA_MIGRATION_FAIL]", {
        message: err.message,
        code: err.code,
        detail: err.detail,
      });
      throw e;
    }

    // 2) Tabelas de chat interno — recria se schema antigo estiver incompatível.
    //    Como ainda não há dados de produção, dropamos e recriamos para garantir
    //    colunas/chaves corretas (chat_id, sender_id, etc.).
    try {
      const cols = await s`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'internal_messages'
      `;
      const hasChatId = cols.some((c) => c.column_name === "chat_id");
      if (cols.length > 0 && !hasChatId) {
        await s.unsafe(`
          DROP TABLE IF EXISTS internal_notifications CASCADE;
          DROP TABLE IF EXISTS internal_messages CASCADE;
          DROP TABLE IF EXISTS internal_chat_members CASCADE;
          DROP TABLE IF EXISTS internal_chats CASCADE;
        `);
      }
    } catch (e) {
      console.warn("[ensureSchema] introspecção falhou, continuando:", (e as Error).message);
    }

    try {
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS internal_chats (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id TEXT,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'group',
          created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS internal_chat_members (
          chat_id UUID NOT NULL REFERENCES internal_chats(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_read_at TIMESTAMPTZ,
          PRIMARY KEY (chat_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS internal_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          chat_id UUID NOT NULL REFERENCES internal_chats(id) ON DELETE CASCADE,
          sender_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS internal_messages_chat_idx ON internal_messages(chat_id, created_at);

        -- Anexos (arquivos salvos em disco/volume; banco guarda só metadados + caminho).
        -- Idempotente e não destrutivo: não remove nem altera mensagens existentes.
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_path TEXT;
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_mime_type TEXT;
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_filename TEXT;
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_original_name TEXT;
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_size INTEGER;
        ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS attachment_type TEXT;

        CREATE TABLE IF NOT EXISTS internal_notifications (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          chat_id UUID NOT NULL REFERENCES internal_chats(id) ON DELETE CASCADE,
          message_id UUID NOT NULL REFERENCES internal_messages(id) ON DELETE CASCADE,
          read_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS internal_notifications_user_idx ON internal_notifications(user_id, read_at);

        -- Isolamento oficial por empresa (Fase B). Idempotente e NÃO destrutivo:
        -- coluna NULL + FK; SEM NOT NULL e SEM backfill automático. Chats antigos
        -- ficam com company_id NULL até backfill manual aprovado.
        ALTER TABLE internal_chats ADD COLUMN IF NOT EXISTS company_id UUID;
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'internal_chats_company_id_fkey'
          ) THEN
            ALTER TABLE internal_chats
              ADD CONSTRAINT internal_chats_company_id_fkey
              FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;
          END IF;
        END$$;
        CREATE INDEX IF NOT EXISTS idx_internal_chats_company ON internal_chats(company_id);
      `);
      console.log("[SCHEMA_CHAT_OK]");
    } catch (e) {
      const err = e as { message?: string; code?: string; detail?: string };
      console.error("[SCHEMA_CHAT_FAIL_IGNORED]", {
        message: err.message,
        code: err.code,
        detail: err.detail,
      });
      // não propaga — não queremos quebrar login/auth por causa do chat interno
    }
  })().catch((e) => {
    // Permite nova tentativa em chamadas futuras se falhar
    _schemaReady = null;
    throw e;
  });
  return _schemaReady;
}
