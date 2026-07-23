/** Re-exporta API de variáveis Evolution (compatibilidade). */
export {
  EVOLUTION_VARIABLE_SUGGESTIONS as EVOLUTION_TEMPLATE_VARIABLES,
  extractEvolutionTemplateVariables as listVariablesInTemplate,
  previewEvolutionTemplate,
  previewEvolutionTemplateWithMappings,
  renderEvolutionTemplateBody,
} from "@/lib/campaign-evolution-variables";

export type { EvolutionVariableMappings } from "@/lib/campaign-evolution-variables";
