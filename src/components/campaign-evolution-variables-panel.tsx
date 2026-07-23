import type {
  EvolutionVariableMappings,
  EvolutionVariableSource,
  EvolutionVariableSourceType,
} from "@/lib/campaign-evolution-variables";
import { EVOLUTION_SOURCE_LABELS } from "@/lib/campaign-evolution-variables";

type Props = {
  variables: string[];
  mappings: EvolutionVariableMappings;
  onChange: (next: EvolutionVariableMappings) => void;
  spreadsheetColumns?: string[];
};

const CONTACT_FIELDS = [
  { value: "name", label: "Nome" },
  { value: "phone", label: "Telefone" },
] as const;

const COMPANY_FIELDS = [
  { value: "name", label: "Nome da empresa" },
  { value: "trade_name", label: "Nome fantasia" },
  { value: "phone", label: "Telefone da empresa" },
] as const;

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
        detail === "phone" ? { source: "contact_field", field: "phone" } : { source: "contact_field", field: "name" };
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
      mapping =
        detail === "trade_name" || detail === "phone"
          ? { source: "company", field: detail }
          : { source: "company", field: "name" };
      break;
    default:
      break;
  }
  if (mapping) next[varName] = mapping;
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
      return mapping.field;
    default:
      return "";
  }
}

export function CampaignEvolutionVariablesPanel({
  variables,
  mappings,
  onChange,
  spreadsheetColumns = [],
}: Props) {
  if (variables.length === 0) return null;

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <p className="text-xs font-medium text-muted-foreground">Variáveis encontradas</p>
      {variables.map((varName) => {
        const mapping = mappings[varName];
        const sourceType = mapping ? sourceTypeOf(mapping) : "spreadsheet_column";
        const detail = mapping ? detailValue(mapping) : varName;

        return (
          <div key={varName} className="grid gap-2 rounded-md border border-border/60 bg-background p-2 sm:grid-cols-[100px_1fr_1fr] sm:items-center">
            <code className="text-xs font-mono">{`{${varName}}`}</code>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Origem</span>
              <select
                value={sourceType}
                onChange={(e) =>
                  onChange(
                    updateMapping(mappings, varName, e.target.value as EvolutionVariableSourceType, detail || varName),
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
                  placeholder="Chave no contato"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                />
              )}
              {sourceType === "spreadsheet_column" && (
                spreadsheetColumns.length > 0 ? (
                  <select
                    value={detail}
                    onChange={(e) =>
                      onChange(updateMapping(mappings, varName, "spreadsheet_column", e.target.value))
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
                      onChange(updateMapping(mappings, varName, "spreadsheet_column", e.target.value))
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
