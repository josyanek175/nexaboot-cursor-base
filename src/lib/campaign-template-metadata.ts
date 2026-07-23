/**
 * Metadados embutidos em campaign_templates.message_body (sem migration).
 * Sufixo oculto: <!--nexaboot:template-meta:{json}-->
 */
import type { ResponseIntent } from "@/lib/campaign-response.server";

export type CampaignTemplateChannelType = "evolution" | "meta" | "both";

export type CampaignTemplateResponseOption = {
  n: number;
  label: string;
  intent: ResponseIntent;
};

export type CampaignTemplateEmbeddedMeta = {
  description?: string;
  channelType?: CampaignTemplateChannelType;
  footer?: string;
  responseOptions?: CampaignTemplateResponseOption[];
  sourceMetaTemplateId?: string;
  sourceMetaTemplateName?: string;
  sourceMetaLanguageCode?: string;
};

const META_SUFFIX_RE = /\n?<!--nexaboot:template-meta:([\s\S]*?)-->\s*$/;

export function serializeTemplateMessageBody(
  visibleBody: string,
  meta: CampaignTemplateEmbeddedMeta,
): string {
  const trimmed = visibleBody.trimEnd();
  const hasMeta =
    meta.description ||
    meta.footer ||
    (meta.responseOptions && meta.responseOptions.length > 0) ||
    meta.sourceMetaTemplateId ||
    meta.channelType;
  if (!hasMeta) return trimmed;
  return `${trimmed}\n<!--nexaboot:template-meta:${JSON.stringify(meta)}-->`;
}

export function parseTemplateMessageBody(raw: string): {
  visibleBody: string;
  meta: CampaignTemplateEmbeddedMeta;
} {
  const match = raw.match(META_SUFFIX_RE);
  if (!match) {
    return { visibleBody: raw.trim(), meta: { channelType: "evolution" } };
  }
  const visibleBody = raw.slice(0, match.index).trimEnd();
  try {
    const meta = JSON.parse(match[1]) as CampaignTemplateEmbeddedMeta;
    return {
      visibleBody,
      meta: { channelType: "evolution", ...meta },
    };
  } catch {
    return { visibleBody, meta: { channelType: "evolution" } };
  }
}

export function stripTemplateMetadata(raw: string): string {
  return parseTemplateMessageBody(raw).visibleBody;
}
