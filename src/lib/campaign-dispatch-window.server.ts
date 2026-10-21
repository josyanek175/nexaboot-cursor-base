/**
 * Persistência e consultas da janela de disparo entre campanhas.
 * Escopo: company_id + telefone (variantes BR).
 */
import { sql } from "@/lib/pg.server";
import type { PgSql } from "@/lib/pg-types";
import { getPhoneVariants, normalizePhone, normalizePhoneForMatch } from "@/lib/phone";
import {
  computeDispatchBlock,
  DEFAULT_DISPATCH_WINDOW_SETTINGS,
  DISPATCH_WINDOW_SKIP_REASON,
  normalizeDispatchWindowSettings,
  type DispatchBlockState,
  type DispatchWindowSettings,
} from "@/lib/campaign-dispatch-window";

export { DISPATCH_WINDOW_SKIP_REASON };

export type PhoneDispatchHistory = {
  sendCount: number;
  lastSentAt: Date;
  lastCampaignId: string | null;
  lastCampaignName: string | null;
  lastName: string | null;
  phone: string;
  phoneMatch: string;
};

export type BlockedDispatchContact = {
  phone: string;
  phoneMatch: string;
  name: string | null;
  sendCount: number;
  windowDays: number;
  lastSentAt: string;
  liberatesAt: string;
  lastCampaignId: string | null;
  lastCampaignName: string | null;
};

let _dispatchSettingsReady: Promise<void> | null = null;

async function ensureDispatchSettingsTable(db: PgSql): Promise<void> {
  if (_dispatchSettingsReady) return _dispatchSettingsReady;

  _dispatchSettingsReady = (async () => {
    try {
      await db.unsafe(`
        CREATE TABLE IF NOT EXISTS public.company_campaign_dispatch_settings (
          company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
          first_window_days INT NOT NULL DEFAULT 7,
          second_window_days INT NOT NULL DEFAULT 10,
          third_window_days INT NOT NULL DEFAULT 30,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL
        );
      `);
      // CHECK separado: evita falha se a tabela já existir sem a constraint nomeada.
      await db.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'company_campaign_dispatch_settings_days_check'
          ) THEN
            ALTER TABLE public.company_campaign_dispatch_settings
              ADD CONSTRAINT company_campaign_dispatch_settings_days_check CHECK (
                first_window_days BETWEEN 1 AND 365
                AND second_window_days BETWEEN 1 AND 365
                AND third_window_days BETWEEN 1 AND 365
              );
          END IF;
        END$$;
      `);
    } catch (e) {
      _dispatchSettingsReady = null;
      const msg = String((e as Error)?.message ?? e);
      // Corrida entre requests: tabela/constraint já criada por outro processo.
      if (
        /already exists/i.test(msg) ||
        /duplicate key/i.test(msg) ||
        /pg_type_typname/i.test(msg)
      ) {
        return;
      }
      throw e;
    }
  })();

  return _dispatchSettingsReady;
}

export async function getCampaignDispatchWindowSettings(
  companyId: string,
  db?: PgSql,
): Promise<DispatchWindowSettings> {
  const s = db ?? sql();
  await ensureDispatchSettingsTable(s);
  const rows = await s<
    {
      first_window_days: number;
      second_window_days: number;
      third_window_days: number;
    }[]
  >`
    SELECT first_window_days, second_window_days, third_window_days
    FROM public.company_campaign_dispatch_settings
    WHERE company_id = ${companyId}::uuid
    LIMIT 1
  `;
  if (!rows[0]) return { ...DEFAULT_DISPATCH_WINDOW_SETTINGS };
  return normalizeDispatchWindowSettings({
    firstWindowDays: rows[0].first_window_days,
    secondWindowDays: rows[0].second_window_days,
    thirdWindowDays: rows[0].third_window_days,
  });
}

export async function saveCampaignDispatchWindowSettings(
  companyId: string,
  userId: string | null,
  input: Partial<DispatchWindowSettings>,
  db?: PgSql,
): Promise<DispatchWindowSettings> {
  const s = db ?? sql();
  await ensureDispatchSettingsTable(s);
  const current = await getCampaignDispatchWindowSettings(companyId, s);
  const next = normalizeDispatchWindowSettings({
    firstWindowDays: input.firstWindowDays ?? current.firstWindowDays,
    secondWindowDays: input.secondWindowDays ?? current.secondWindowDays,
    thirdWindowDays: input.thirdWindowDays ?? current.thirdWindowDays,
  });

  await s`
    INSERT INTO public.company_campaign_dispatch_settings
      (company_id, first_window_days, second_window_days, third_window_days, updated_at, updated_by_user_id)
    VALUES (
      ${companyId}::uuid,
      ${next.firstWindowDays},
      ${next.secondWindowDays},
      ${next.thirdWindowDays},
      now(),
      ${userId}::uuid
    )
    ON CONFLICT (company_id) DO UPDATE SET
      first_window_days = EXCLUDED.first_window_days,
      second_window_days = EXCLUDED.second_window_days,
      third_window_days = EXCLUDED.third_window_days,
      updated_at = now(),
      updated_by_user_id = EXCLUDED.updated_by_user_id
  `;

  return next;
}

type SentRow = {
  phone: string;
  name: string | null;
  sent_at: Date | string;
  campaign_id: string;
  campaign_name: string | null;
};

function aggregateHistoryByPhoneMatch(rows: SentRow[]): Map<string, PhoneDispatchHistory> {
  const map = new Map<string, PhoneDispatchHistory>();

  for (const row of rows) {
    const phone = normalizePhone(row.phone);
    if (!phone) continue;
    const phoneMatch = normalizePhoneForMatch(phone);
    const sentAt = row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at);
    if (Number.isNaN(sentAt.getTime())) continue;

    const prev = map.get(phoneMatch);
    if (!prev) {
      map.set(phoneMatch, {
        sendCount: 1,
        lastSentAt: sentAt,
        lastCampaignId: row.campaign_id,
        lastCampaignName: row.campaign_name,
        lastName: row.name,
        phone,
        phoneMatch,
      });
      continue;
    }

    prev.sendCount += 1;
    if (sentAt.getTime() >= prev.lastSentAt.getTime()) {
      prev.lastSentAt = sentAt;
      prev.lastCampaignId = row.campaign_id;
      prev.lastCampaignName = row.campaign_name;
      prev.lastName = row.name ?? prev.lastName;
      prev.phone = phone;
    }
  }

  return map;
}

async function loadCompanySentRows(companyId: string, db: PgSql): Promise<SentRow[]> {
  return db<SentRow[]>`
    SELECT
      cc.phone,
      cc.name,
      cc.sent_at,
      cc.campaign_id,
      c.name AS campaign_name
    FROM public.campaign_contacts cc
    INNER JOIN public.campaigns c
      ON c.id = cc.campaign_id
     AND c.company_id = cc.company_id
    WHERE cc.company_id = ${companyId}::uuid
      AND cc.status = 'sent'
      AND cc.sent_at IS NOT NULL
      AND c.deleted_at IS NULL
  `;
}

/** Histórico agregado da empresa (phone_match → contagem / último envio). */
export async function loadCompanyDispatchHistory(
  companyId: string,
  db?: PgSql,
): Promise<Map<string, PhoneDispatchHistory>> {
  const s = db ?? sql();
  const rows = await loadCompanySentRows(companyId, s);
  return aggregateHistoryByPhoneMatch(rows);
}

export async function getPhoneDispatchBlockState(
  companyId: string,
  phone: string,
  opts?: {
    db?: PgSql;
    now?: Date;
    settings?: DispatchWindowSettings;
    history?: Map<string, PhoneDispatchHistory>;
  },
): Promise<DispatchBlockState | null> {
  const digits = normalizePhone(phone);
  if (!digits) return null;

  const settings =
    opts?.settings ?? (await getCampaignDispatchWindowSettings(companyId, opts?.db));
  const history = opts?.history ?? (await loadCompanyDispatchHistory(companyId, opts?.db));
  const phoneMatch = normalizePhoneForMatch(digits);

  let entry = history.get(phoneMatch);
  if (!entry) {
    // Fallback: buscar por variantes no mapa (caso a chave tenha sido outra forma).
    for (const variant of getPhoneVariants(digits)) {
      const key = normalizePhoneForMatch(variant);
      entry = history.get(key);
      if (entry) break;
    }
  }
  if (!entry) return null;

  return computeDispatchBlock({
    sendCount: entry.sendCount,
    lastSentAt: entry.lastSentAt,
    now: opts?.now,
    settings,
  });
}

export async function isPhoneInCampaignDispatchWindow(
  companyId: string,
  phone: string,
  db?: PgSql,
): Promise<boolean> {
  const state = await getPhoneDispatchBlockState(companyId, phone, { db });
  return !!state?.blocked;
}

/** Contatos ainda bloqueados (somem da lista ao liberar). */
export async function listBlockedDispatchContacts(
  companyId: string,
  opts?: { db?: PgSql; now?: Date; settings?: DispatchWindowSettings },
): Promise<BlockedDispatchContact[]> {
  const s = opts?.db ?? sql();
  const settings =
    opts?.settings ?? (await getCampaignDispatchWindowSettings(companyId, s));
  const history = await loadCompanyDispatchHistory(companyId, s);
  const now = opts?.now ?? new Date();
  const out: BlockedDispatchContact[] = [];

  for (const entry of history.values()) {
    const state = computeDispatchBlock({
      sendCount: entry.sendCount,
      lastSentAt: entry.lastSentAt,
      now,
      settings,
    });
    if (!state?.blocked) continue;
    out.push({
      phone: entry.phone,
      phoneMatch: entry.phoneMatch,
      name: entry.lastName,
      sendCount: state.sendCount,
      windowDays: state.windowDays,
      lastSentAt: state.lastSentAt.toISOString(),
      liberatesAt: state.liberatesAt.toISOString(),
      lastCampaignId: entry.lastCampaignId,
      lastCampaignName: entry.lastCampaignName,
    });
  }

  out.sort((a, b) => b.liberatesAt.localeCompare(a.liberatesAt));
  return out;
}
