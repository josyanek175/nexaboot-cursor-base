import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { Upload, FileSpreadsheet, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { parsePastedText } from "@/lib/campaign-spreadsheet";

export type ImportPreviewData = {
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
  rows: {
    index: number;
    name: string;
    phone: string;
    status: string;
    reason?: string;
  }[];
};

type Props = {
  campaignId: string;
  messageTemplate: string;
  disabled?: boolean;
  onImported: () => void;
};

async function readSpreadsheetFile(file: File): Promise<Record<string, unknown>[]> {
  const buf = await file.arrayBuffer();
  const lower = file.name.toLowerCase();
  let workbook: XLSX.WorkBook;

  if (lower.endsWith(".csv") || file.type === "text/csv") {
    const text = new TextDecoder("utf-8").decode(new Uint8Array(buf));
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    const semis = (firstLine.match(/;/g) ?? []).length;
    const commas = (firstLine.match(/,/g) ?? []).length;
    const FS = semis >= commas ? ";" : ",";
    workbook = XLSX.read(text, { type: "string", FS, raw: false });
  } else {
    workbook = XLSX.read(buf, { type: "array" });
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    defval: "",
    raw: false,
  });
}

export function CampaignAudienceImport({
  campaignId,
  messageTemplate,
  disabled,
  onImported,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [preview, setPreview] = useState<ImportPreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function runPreview(rows: Record<string, unknown>[]) {
    if (rows.length === 0) {
      toast.error("Nenhuma linha encontrada na lista");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/campaigns/${encodeURIComponent(campaignId)}/import/preview`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { preview: ImportPreviewData };
      setRawRows(rows);
      setPreview(data.preview);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rows = await readSpreadsheetFile(file);
      await runPreview(rows);
    } catch {
      toast.error("Não foi possível ler o arquivo");
    }
    e.target.value = "";
  }

  async function handlePastePreview() {
    const rows = parsePastedText(pasteText);
    await runPreview(rows);
  }

  async function handleConfirm() {
    if (!preview || rawRows.length === 0) return;
    const validIndices = preview.rows
      .filter((r) => r.status === "valid")
      .map((r) => r.index);
    if (validIndices.length === 0) {
      toast.error("Nenhum contato válido para importar");
      return;
    }
    setConfirming(true);
    try {
      const res = await fetch(
        `/api/campaigns/${encodeURIComponent(campaignId)}/import/confirm`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: rawRows, row_indices: validIndices }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const result = (await res.json()) as { added: number; skipped: number };
      toast.success(`${result.added} contato(s) importado(s)`);
      setPreview(null);
      setRawRows([]);
      setPasteText("");
      onImported();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4">
        <p className="mb-3 text-sm font-medium">Importar lista de disparo</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Colunas obrigatórias: <strong>nome</strong> e <strong>telefone</strong>.
          Demais colunas viram tags para a mensagem (ex.: {"{produto}"}, {"{endereco}"}).
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            className="hidden"
            disabled={disabled}
            onChange={handleFile}
          />
          <button
            type="button"
            disabled={disabled || loading}
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            CSV / XLSX
          </button>
        </div>

        <div className="mt-4">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Ou cole a planilha (com cabeçalho)
          </span>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            disabled={disabled}
            rows={4}
            placeholder={"nome;telefone;produto\nJoão;5534999999999;Plano Pro"}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-whatsapp"
          />
          <button
            type="button"
            disabled={disabled || loading || !pasteText.trim()}
            onClick={handlePastePreview}
            className="mt-2 inline-flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs hover:bg-muted/80 disabled:opacity-60"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Analisar lista colada
          </button>
        </div>
      </div>

      {preview && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-medium">Prévia da importação</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Total" value={preview.total} />
            <Stat label="Válidos" value={preview.valid} tone="text-whatsapp" />
            <Stat label="Inválidos" value={preview.invalid} tone="text-destructive" />
            <Stat label="Duplicados" value={preview.duplicated} tone="text-amber-600" />
            <Stat label="Opt-out" value={preview.optOut} tone="text-destructive" />
          </div>

          {preview.availableTags.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Tags disponíveis:</p>
              <div className="flex flex-wrap gap-1">
                {preview.availableTags.map((t) => (
                  <span
                    key={t}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {`{${t}}`}
                  </span>
                ))}
              </div>
            </div>
          )}

          {preview.samplePreview && messageTemplate.trim() && (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Prévia da mensagem — {preview.samplePreview.name} ({preview.samplePreview.phone})
              </p>
              <pre className="whitespace-pre-wrap text-xs">{preview.samplePreview.renderedMessage}</pre>
            </div>
          )}

          {preview.valid > 0 ? (
            <button
              type="button"
              disabled={disabled || confirming}
              onClick={handleConfirm}
              className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-60"
            >
              {confirming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Importar {preview.valid} contato(s) válido(s)
            </button>
          ) : (
            <p className="flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              Nenhum contato válido na lista.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "text-foreground",
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-md border border-border px-2 py-1.5 text-center">
      <div className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
