/**
 * Converte template Meta aprovado em rascunho Evolution editável.
 * Não altera o template Meta original (somente leitura).
 */
import type { ResponseIntent } from "@/lib/campaign-response.server";
import {
  type CampaignTemplateEmbeddedMeta,
  type CampaignTemplateResponseOption,
  serializeTemplateMessageBody,
} from "@/lib/campaign-template-metadata";
import { extractBodyText, extractButtons } from "@/lib/meta-template-render";

/** Mapeamento padrão {{n}} → variável Evolution. */
export const DEFAULT_META_TO_EVOLUTION_VARS: Record<string, string> = {
  "1": "nome",
  "2": "telefone",
  "3": "produto",
  "4": "endereco",
  "5": "data_ultima_troca",
};

const DEFAULT_BUTTON_INTENTS: ResponseIntent[] = ["interested", "unknown", "interested"];

function metaVarToEvolutionPlaceholder(
  index: string,
  mappings?: Record<string, string>,
): string {
  const field = mappings?.[index] ?? DEFAULT_META_TO_EVOLUTION_VARS[index] ?? "nome";
  if (field === "name") return "{nome}";
  if (field === "phone") return "{telefone}";
  return `{${field}}`;
}

export function convertMetaPlaceholdersToEvolution(
  body: string,
  mappings?: Record<string, string>,
): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_m, idx: string) =>
    metaVarToEvolutionPlaceholder(idx, mappings),
  );
}

export function buildNumberedResponseOptions(
  buttons: string[],
  intents?: ResponseIntent[],
): CampaignTemplateResponseOption[] {
  return buttons.map((label, i) => ({
    n: i + 1,
    label: label.trim(),
    intent: intents?.[i] ?? DEFAULT_BUTTON_INTENTS[i] ?? "unknown",
  }));
}

export function formatNumberedResponseBlock(options: CampaignTemplateResponseOption[]): string {
  if (options.length === 0) return "";
  const lines = options.map((o) => `${o.n} - ${o.label}`);
  return `\n\nResponda:\n${lines.join("\n")}`;
}

export type MetaToEvolutionConversion = {
  name: string;
  visibleBody: string;
  storedBody: string;
  meta: CampaignTemplateEmbeddedMeta;
  responseOptions: CampaignTemplateResponseOption[];
};

export function convertMetaTemplateToEvolutionDraft(opts: {
  templateName: string;
  languageCode: string;
  components: unknown;
  metaTemplateId?: string | null;
  metaVariableMappings?: Record<string, string>;
  customName?: string;
  footer?: string;
}): MetaToEvolutionConversion {
  const bodyRaw = extractBodyText(opts.components) ?? "";
  const buttons = extractButtons(opts.components);
  const convertedBody = convertMetaPlaceholdersToEvolution(
    bodyRaw,
    opts.metaVariableMappings,
  );
  const responseOptions = buildNumberedResponseOptions(buttons);
  const footer = opts.footer?.trim() ?? "";
  const footerBlock = footer ? `\n\n${footer}` : "";
  const responseBlock = formatNumberedResponseBlock(responseOptions);
  const visibleBody = `${convertedBody}${footerBlock}${responseBlock}`.trim();

  const meta: CampaignTemplateEmbeddedMeta = {
    description: `Versão Evolution do template Meta «${opts.templateName}» (${opts.languageCode})`,
    channelType: "evolution",
    footer: footer || undefined,
    responseOptions,
    sourceMetaTemplateId: opts.metaTemplateId ?? undefined,
    sourceMetaTemplateName: opts.templateName,
    sourceMetaLanguageCode: opts.languageCode,
  };

  const name =
    opts.customName?.trim() ||
    `Evolution · ${opts.templateName}`;

  return {
    name,
    visibleBody,
    storedBody: serializeTemplateMessageBody(visibleBody, meta),
    meta,
    responseOptions,
  };
}
