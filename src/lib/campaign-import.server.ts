// Importação de público direto na campanha (planilha / lista).
import { sql } from "@/lib/pg.server";
import { normalizePhone, normalizePhoneForMatch } from "@/lib/phone";
import { isInvalidCampaignPhone } from "@/lib/campaign-send-policy";
import { isPhoneInOptOutList } from "@/lib/campaign-response.server";
import {
  parseSpreadsheetRow,
  collectAvailableTags,
  previewMessage,
  type ParsedSpreadsheetRow,
  type NormalizedImportRow,
} from "@/lib/campaign-spreadsheet";
import {
  getCampaignById,
  syncCampaignContactCounters,
  insertCampaignEvent,
} from "@/lib/campaign.server";

export type ImportPreviewResult = {
  total: number;
  valid: number;
  invalid: number;
  duplicated: number;
  optOut: number;
  availableTags: string[];
  samplePreview: {
    name: string;
    phone: string;
    variables: Record<string, string>;
    renderedMessage: string;
  } | null;
  rows: NormalizedImportRow[];
};

function parseRawRows(rawRows: Record<string, unknown>[]): ParsedSpreadsheetRow[] {
  const parsed: ParsedSpreadsheetRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const row = parseSpreadsheetRow(rawRows[i], i);
    if (row) parsed.push(row);
  }
  return parsed;
}

async function loadExistingPhoneMatches(companyId: string, campaignId: string): Promise<Set<string>> {
  const rows = await sql<{ phone: string }[]>`
    SELECT phone FROM public.campaign_contacts
    WHERE campaign_id = ${campaignId}::uuid
      AND company_id = ${companyId}::uuid
  `;
  return new Set(rows.map((r) => normalizePhoneForMatch(r.phone)));
}

async function classifyRows(
  companyId: string,
  campaignId: string | null,
  parsed: ParsedSpreadsheetRow[],
  messageTemplate?: string | null,
): Promise<ImportPreviewResult> {
  const existingPhones = campaignId
    ? await loadExistingPhoneMatches(companyId, campaignId)
    : new Set<string>();
  const seenInBatch = new Set<string>();
  const normalized: NormalizedImportRow[] = [];

  let valid = 0;
  let invalid = 0;
  let duplicated = 0;
  let optOut = 0;

  for (const row of parsed) {
    const phoneDigits = normalizePhone(row.phone);
    const phoneMatch = normalizePhoneForMatch(row.phone);
    let status: NormalizedImportRow["status"] = "valid";
    let reason: string | undefined;

    if (!row.name.trim()) {
      status = "invalid";
      reason = "missing_name";
    } else if (!phoneDigits) {
      status = "invalid";
      reason = "missing_phone";
    } else if (isInvalidCampaignPhone(phoneDigits)) {
      status = "invalid";
      reason = "invalid_phone";
    } else if (seenInBatch.has(phoneMatch)) {
      status = "duplicate";
      reason = "duplicate_in_file";
    } else if (existingPhones.has(phoneMatch)) {
      status = "duplicate";
      reason = "duplicate_in_campaign";
    } else if (await isPhoneInOptOutList(companyId, phoneDigits)) {
      status = "opt_out";
      reason = "opt_out_list";
    }

    seenInBatch.add(phoneMatch);

    if (status === "valid") valid++;
    else if (status === "invalid") invalid++;
    else if (status === "duplicate") duplicated++;
    else if (status === "opt_out") optOut++;

    normalized.push({
      ...row,
      phoneDigits,
      status,
      reason,
    });
  }

  const firstValid = normalized.find((r) => r.status === "valid") ?? null;
  const samplePreview = firstValid
    ? {
        name: firstValid.name,
        phone: firstValid.phone,
        variables: firstValid.variables,
        renderedMessage: previewMessage(messageTemplate ?? "", firstValid),
      }
    : null;

  return {
    total: parsed.length,
    valid,
    invalid,
    duplicated,
    optOut,
    availableTags: collectAvailableTags(parsed),
    samplePreview,
    rows: normalized,
  };
}

export async function previewCampaignImport(opts: {
  companyId: string;
  campaignId: string;
  rows: Record<string, unknown>[];
}): Promise<ImportPreviewResult | null> {
  const campaign = await getCampaignById(opts.companyId, opts.campaignId);
  if (!campaign) return null;
  const parsed = parseRawRows(opts.rows);
  return classifyRows(opts.companyId, opts.campaignId, parsed, campaign.message_text);
}

export async function confirmCampaignImport(opts: {
  companyId: string;
  campaignId: string;
  userId: string | null;
  /** Índices das linhas válidas a importar (re-validados no servidor). */
  rowIndices: number[];
  rows: Record<string, unknown>[];
}): Promise<{ added: number; skipped: number } | null> {
  const campaign = await getCampaignById(opts.companyId, opts.campaignId);
  if (!campaign) return null;
  if (campaign.status !== "draft") throw new Error("not_draft");

  const preview = await classifyRows(
    opts.companyId,
    opts.campaignId,
    parseRawRows(opts.rows),
    campaign.message_text,
  );

  const indexSet = new Set(opts.rowIndices);
  const toImport = preview.rows.filter(
    (r) => r.status === "valid" && indexSet.has(r.index),
  );

  let added = 0;
  let skipped = preview.total - toImport.length;

  for (const row of toImport) {
    const phone = normalizePhone(row.phone);
    try {
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO public.campaign_contacts
          (campaign_id, company_id, contact_id, phone, name, variables, status)
        VALUES (
          ${opts.campaignId}::uuid,
          ${opts.companyId}::uuid,
          NULL,
          ${phone},
          ${row.name.trim()},
          ${row.variables as unknown as Record<string, never>},
          'pending'
        )
        ON CONFLICT (campaign_id, phone) DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) added++;
      else skipped++;
    } catch {
      skipped++;
    }
  }

  await syncCampaignContactCounters(opts.campaignId, opts.companyId);
  await insertCampaignEvent(opts.companyId, opts.campaignId, "contacts.imported", opts.userId, {
    requested: opts.rowIndices.length,
    added,
    skipped,
  });

  return { added, skipped };
}
