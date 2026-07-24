import type {
  EvolutionVariableMappings,
  EvolutionVariableSource,
  EvolutionVariableSourceType,
} from "@/lib/campaign-evolution-variables";
import {
  EVOLUTION_SOURCE_LABELS,
  markEvolutionMappingConfirmed,
} from "@/lib/campaign-evolution-variables";

type Props = {
  variables: string[];
  mappings: EvolutionVariableMappings;
  onChange: (next: EvolutionVariableMappings) => void;
  spreadsheetColumns?: string[];
  requiresConfirmation?: boolean;
};

const CONTACT_FIELDS = [
  { value: "name", label: "Nome" },
  { value: "phone", label: "Telefone" },
] as const;

const COMPANY_FIELDS = [{ value: "name", label: "Nome da empresa" }] as const;

function sourceTypeOf(mapping: EvolutionVariableSource): EvolutionVariableSourceType {
  return mapping.source;
}

function updateMapping(
  mappings: EvolutionVariableMappings,
  varName: string,
  sourceType: EvolutionVariableSourceType,
  detail: string,
): EvolutionVariableMappings {
  const next = { ...mappings };
  let mapping: EvolutionVariableSource | null = null;
  switch (sourceType) {
    case "contact_field":
      mapping =
        detail === "phone"
          ? { source: "contact_field", field: "phone" }
          : { source: "contact_field", field: "name" };
      break;
    case "contact_variable":
      mapping = { source: "contact_variable", key: detail || varName };
      break;
    case "spreadsheet_column":
      mapping = { source: "spreadsheet_column", column: detail || varName };
      break;
    case "campaign_fixed":
      mapping = { source: "campaign_fixed", value: detail };
      break;
    case "attendant":
      mapping = { source: "attendant", field: "name" };
      break;
    case "company":
      mapping = { source: "company", field: "name" };
      break;
    default:
      break;
  }
  if (mapping) next[varName] = markEvolutionMappingConfirmed(mapping);
  return next;
}

function detailValue(mapping: EvolutionVariableSource): string {
  switch (mapping.source) {
    case "contact_field":
      return mapping.field;
    case "contact_variable":
      return mapping.key;
    case "spreadsheet_column":
      return mapping.column;
    case "campaign_fixed":
      return mapping.value;
    case "attendant":
      return "name";
    case "company":
      return "name";
    default:
      return "";
  }
}

export function CampaignEvolutionVariablesPanel({
  variables,
  mappings,
  onChange,
  spreadsheetColumns = [],
  requiresConfirmation = true,
}: Props) {
  if (variables.length === 0) return null;

  const pendingCount = requiresConfirmation
    ? variables.filter((v) => mappings[v]?.confirmed !== true).length
    : 0;

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Variáveis encontradas</p>
        {requiresConfirmation && pendingCount > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            {pendingCount} pendente{pendingCount === 1 ? "" : "s"} de confirmação
          </span>
        )}
      </div>
      {requiresConfirmation && (
        <p className="text-[11px] text-muted-foreground">
          Sugestões automáticas são apenas ponto de partida. Altere a origem ou o detalhe para
          confirmar cada variável antes de agendar.
        </p>
      )}
      {variables.map((varName) => {
        const mapping = mappings[varName];
        const sourceType = mapping ? sourceTypeOf(mapping) : "spreadsheet_column";
        const detail = mapping ? detailValue(mapping) : varName;
        const isConfirmed = !requiresConfirmation || mapping?.confirmed === true;

        return (
          <div
            key={varName}
            className={`grid gap-2 rounded-md border bg-background p-2 sm:grid-cols-[100px_1fr_1fr] sm:items-center ${
              isConfirmed ? "border-border/60" : "border-amber-500/40"
            }`}
          >
            <div>
              <code className="text-xs font-mono">{`{${varName}}`}</code>
              {requiresConfirmation && !isConfirmed && (
                <p className="mt-0.5 text-[10px] text-amber-700 dark:text-amber-300">Não confirmada</p>
              )}
            </div>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Origem</span>
              <select
                value={sourceType}
                onChange={(e) =>
                  onChange(
                    updateMapping(
                      mappings,
                      varName,
                      e.target.value as EvolutionVariableSourceType,
                      detail || varName,
                    ),
                  )
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                {(Object.keys(EVOLUTION_SOURCE_LABELS) as EvolutionVariableSourceType[]).map((k) => (
                  <option key={k} value={k}>
                    {EVOLUTION_SOURCE_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Detalhe</span>
              {sourceType === "contact_field" && (
                <select
                  value={detail}
                  onChange={(e) =>
                    onChange(updateMapping(mappings, varName, "contact_field", e.target.value))
                  }
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                >
                  {CONTACT_FIELDS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              )}
              {sourceType === "company" && (
                <select
                  value={detail}
                  onChange={(e) =>
                    onChange(updateMapping(mappings, varName, "company", e.target.value))
                  }
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                >
                  {COMPANY_FIELDS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              )}
              {sourceType === "attendant" && (
                <input
                  readOnly
                  value="Nome do atendente"
                  onFocus={() =>
                    onChange(updateMapping(mappings, varName, "attendant", "name"))
                  }
                  className="w-full rounded-md border border-input bg-muted/40 px-2 py-1.5"
                />
              )}
              {sourceType === "campaign_fixed" && (
                <input
                  value={detail}
                  onChange={(e) =>
                    onChange(updateMapping(mappings, varName, "campaign_fixed", e.target.value))
                  }
                  placeholder="Valor fixo para todos os contatos"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                />
              )}
              {sourceType === "contact_variable" && (
                <input
                  value={detail}
                  onChange={(e) =>
                    onChange(updateMapping(mappings, varName, "contact_variable", e.target.value))
                  }
                  placeholder="Chave no contato (CRM ou planilha)"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                />
              )}
              {sourceType === "spreadsheet_column" && (
                spreadsheetColumns.length > 0 ? (
                  <select
                    value={detail}
                    onChange={(e) =>
                      onChange(
                        updateMapping(mappings, varName, "spreadsheet_column", e.target.value),
                      )
                    }
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                  >
                    {spreadsheetColumns.map((col) => (
                      <option key={col} value={col}>
                        {col}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={detail}
                    onChange={(e) =>
                      onChange(
                        updateMapping(mappings, varName, "spreadsheet_column", e.target.value),
                      )
                    }
                    placeholder="Nome da coluna"
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                  />
                )
              )}
            </label>
          </div>
        );
      })}
    </div>
  );
}
