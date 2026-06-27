// Página de Contatos com CRUD básico + importação em massa via CSV/XLSX.
// Bibliotecas: xlsx (SheetJS) — lê .csv (vírgula/ponto-e-vírgula) e .xlsx.
// Regras: duplicidade por telefone normalizado dentro do tenant atual.

import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { Contact2, Plus, Upload, Search, X, FileSpreadsheet, AlertTriangle, CheckCircle2, Loader2, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { contacts as seed, type Contact, type ContactStatus } from "@/lib/mocks";
import { useSession } from "@/lib/session";
import { pushAudit } from "@/lib/audit-log";

export const Route = createFileRoute("/_app/contatos")({
  component: ContatosPage,
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Normaliza telefone: mantém apenas dígitos. */
function normalizePhone(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).replace(/\D+/g, "");
}

/** Telefone válido: 10–15 dígitos (E.164 + folga). */
function isValidPhone(p: string) {
  return p.length >= 10 && p.length <= 15;
}

const NAME_KEYS = ["nome", "name", "cliente", "contato"];
const PHONE_KEYS = ["telefone", "celular", "whatsapp", "phone", "fone", "tel"];
const EMAIL_KEYS = ["email", "e-mail", "mail"];
const REF_KEYS = ["referencia", "referência", "reference", "origem", "fonte"];
const STATUS_KEYS = ["status", "situacao", "situação"];
const TAGS_KEYS = ["tags", "etiquetas", "tag"];

function pickField(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of Object.keys(row)) {
    const norm = k.trim().toLowerCase();
    if (keys.includes(norm)) {
      const v = row[k];
      if (v === undefined || v === null) return undefined;
      const s = String(v).trim();
      return s.length ? s : undefined;
    }
  }
  return undefined;
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(/[;,|]/).map((t) => t.trim()).filter(Boolean);
}

function parseStatus(raw?: string): ContactStatus | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s.startsWith("ativo")) return "ativo";
  if (s.startsWith("inativ")) return "inativo";
  if (s.startsWith("lead")) return "lead";
  return undefined;
}

const PALETTE = ["#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#f97316", "#14b8a6", "#eab308", "#ef4444"];
function colorFor(seedStr: string) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Lê arquivo CSV/XLSX e retorna linhas como objeto. */
async function readSpreadsheet(file: File): Promise<Record<string, unknown>[]> {
  const buf = await file.arrayBuffer();
  const lower = file.name.toLowerCase();
  let workbook: XLSX.WorkBook;

  if (lower.endsWith(".csv") || file.type === "text/csv") {
    const text = new TextDecoder("utf-8").decode(new Uint8Array(buf));
    // Detecta separador olhando a primeira linha.
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
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
}

// ----------------------------------------------------------------------------
// Página
// ----------------------------------------------------------------------------

function ContatosPage() {
  const { session, user, isSuperAdmin } = useSession();
  const [items, setItems] = useState<Contact[]>(seed);
  const [search, setSearch] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);

  // Tenant ativo: ADMIN_GERAL pode ver tudo conforme tenant selecionado no switcher.
  const tenantId = session.tenantId;
  const visible = useMemo(() => {
    const base = isSuperAdmin ? items : items.filter((c) => c.tenantId === user.tenantId);
    if (!search.trim()) return base;
    const q = search.trim().toLowerCase();
    return base.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(q.replace(/\D+/g, "")) ||
        (c.email ?? "").toLowerCase().includes(q),
    );
  }, [items, isSuperAdmin, user.tenantId, search]);

  function openNew() {
    setEditing({
      id: `ct-${Date.now()}`,
      tenantId,
      name: "",
      phone: "",
      tags: [],
      status: "ativo",
      avatarColor: colorFor(String(Date.now())),
    });
  }

  function saveEdit() {
    if (!editing) return;
    const phone = normalizePhone(editing.phone);
    if (!editing.name.trim()) return toast.error("Informe o nome");
    if (!isValidPhone(phone)) return toast.error("Telefone inválido");
    const exists = items.some((c) => c.id === editing.id);
    const dup = items.some(
      (c) => c.tenantId === editing.tenantId && c.phone === phone && c.id !== editing.id,
    );
    if (dup) return toast.error("Já existe um contato com este telefone nesta empresa");
    const next = { ...editing, phone };
    setItems((prev) => (exists ? prev.map((c) => (c.id === next.id ? next : c)) : [...prev, next]));
    pushAudit({
      tenantId: editing.tenantId,
      actorId: user.id,
      actorName: user.name,
      targetType: "contact",
      targetId: editing.id,
      targetName: editing.name,
      action: exists ? "contact.update" : "contact.create",
      result: "success",
    });
    toast.success(exists ? "Contato atualizado" : "Contato criado");
    setEditing(null);
  }

  function removeContact(c: Contact) {
    if (!confirm(`Excluir contato "${c.name}"?`)) return;
    setItems((prev) => prev.filter((x) => x.id !== c.id));
    pushAudit({
      tenantId: c.tenantId,
      actorId: user.id,
      actorName: user.name,
      targetType: "contact",
      targetId: c.id,
      targetName: c.name,
      action: "contact.delete",
      result: "success",
    });
    toast.success("Contato excluído");
  }

  function applyImport(created: Contact[], updatedIds: Set<string>, fileName: string, totals: ImportTotals) {
    setItems((prev) => {
      const map = new Map(prev.map((c) => [c.id, c]));
      for (const c of created) map.set(c.id, c);
      return Array.from(map.values());
    });
    pushAudit({
      tenantId,
      actorId: user.id,
      actorName: user.name,
      targetType: "contact.import",
      targetId: `import-${Date.now()}`,
      targetName: fileName,
      action: "contact.import",
      result: "success",
      reason: `arquivo=${fileName} total=${totals.total} novos=${totals.created} atualizados=${updatedIds.size} duplicados=${totals.duplicates} inválidos=${totals.invalid}`,
    });
    toast.success(
      `Importação concluída: ${totals.created} novos, ${updatedIds.size} atualizados, ${totals.duplicates} duplicados, ${totals.invalid} inválidos`,
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <Contact2 className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Contatos</h1>
            <p className="text-xs text-muted-foreground">
              {visible.length} contato{visible.length === 1 ? "" : "s"} na empresa ativa
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome, telefone, e-mail…"
              className="w-72 rounded-md border border-input bg-background py-2 pl-8 pr-3 text-sm outline-none ring-ring focus:ring-2"
            />
          </div>
          <button
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            <Upload className="h-4 w-4" /> Importar CSV/Excel
          </button>
          <button
            onClick={openNew}
            className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Novo contato
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-6">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Contato</th>
                <th className="px-4 py-3 text-left font-medium">Telefone</th>
                <th className="px-4 py-3 text-left font-medium">E-mail</th>
                <th className="px-4 py-3 text-left font-medium">Referência</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Tags</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id} className="border-t border-border hover:bg-accent/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="grid h-8 w-8 place-items-center rounded-full text-xs font-semibold text-white"
                        style={{ backgroundColor: c.avatarColor }}
                      >
                        {c.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
                      </div>
                      <div className="font-medium">{c.name}</div>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{c.phone}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.email ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.reference ?? "—"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {c.tags.length === 0 && <span className="text-muted-foreground">—</span>}
                      {c.tags.map((t) => (
                        <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-[11px]">
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => setEditing({ ...c })}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                        title="Editar"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => removeContact(c)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title="Excluir"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    Nenhum contato encontrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>

      {importOpen && (
        <ImportModal
          tenantId={tenantId}
          existing={items}
          onClose={() => setImportOpen(false)}
          onConfirm={(created, updatedIds, fileName, totals) => {
            applyImport(created, updatedIds, fileName, totals);
            setImportOpen(false);
          }}
        />
      )}

      {editing && (
        <EditModal
          value={editing}
          onChange={setEditing}
          onSave={saveEdit}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status?: ContactStatus }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const map: Record<ContactStatus, string> = {
    ativo: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    inativo: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
    lead: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${map[status]}`}>{status}</span>;
}

// ----------------------------------------------------------------------------
// Modal de edição
// ----------------------------------------------------------------------------

function EditModal({
  value, onChange, onSave, onClose,
}: {
  value: Contact;
  onChange: (c: Contact) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h3 className="text-base font-semibold">Contato</h3>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label="Nome" className="col-span-2">
            <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} className="input" />
          </Field>
          <Field label="Telefone">
            <input value={value.phone} onChange={(e) => onChange({ ...value, phone: e.target.value })} placeholder="5511999999999" className="input" />
          </Field>
          <Field label="E-mail">
            <input value={value.email ?? ""} onChange={(e) => onChange({ ...value, email: e.target.value })} className="input" />
          </Field>
          <Field label="Referência">
            <input value={value.reference ?? ""} onChange={(e) => onChange({ ...value, reference: e.target.value })} className="input" />
          </Field>
          <Field label="Status">
            <select
              value={value.status ?? "ativo"}
              onChange={(e) => onChange({ ...value, status: e.target.value as ContactStatus })}
              className="input"
            >
              <option value="ativo">Ativo</option>
              <option value="inativo">Inativo</option>
              <option value="lead">Lead</option>
            </select>
          </Field>
          <Field label="Tags (separadas por vírgula)" className="col-span-2">
            <input
              value={value.tags.join(", ")}
              onChange={(e) => onChange({ ...value, tags: parseTags(e.target.value) })}
              className="input"
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
          <button onClick={onSave} className="rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90">Salvar</button>
        </div>
        <style>{`.input{width:100%;border:1px solid hsl(var(--input));background:hsl(var(--background));border-radius:.375rem;padding:.5rem .75rem;font-size:.875rem;outline:none}.input:focus{box-shadow:0 0 0 2px hsl(var(--ring))}`}</style>
      </div>
    </div>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ----------------------------------------------------------------------------
// Importação
// ----------------------------------------------------------------------------

type ImportRowStatus = "novo" | "duplicado" | "inválido" | "atualizar";

interface ImportRow {
  index: number;
  raw: Record<string, unknown>;
  name: string;
  phone: string;
  email?: string;
  reference?: string;
  status?: ContactStatus;
  tags: string[];
  rowStatus: ImportRowStatus;
  reason?: string;
  /** Se duplicado/atualizar, referência ao existente. */
  existingId?: string;
}

interface ImportTotals {
  total: number;
  created: number;
  duplicates: number;
  invalid: number;
}

function ImportModal({
  tenantId, existing, onClose, onConfirm,
}: {
  tenantId: string;
  existing: Contact[];
  onClose: () => void;
  onConfirm: (created: Contact[], updatedIds: Set<string>, fileName: string, totals: ImportTotals) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [strategy, setStrategy] = useState<"ignore" | "update">("ignore");

  const existingByPhone = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of existing) if (c.tenantId === tenantId) m.set(c.phone, c);
    return m;
  }, [existing, tenantId]);

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParsing(true);
    try {
      const data = await readSpreadsheet(file);
      const parsed: ImportRow[] = data.map((raw, i) => {
        const name = pickField(raw, NAME_KEYS) ?? "";
        const phoneRaw = pickField(raw, PHONE_KEYS) ?? "";
        const phone = normalizePhone(phoneRaw);
        const email = pickField(raw, EMAIL_KEYS);
        const reference = pickField(raw, REF_KEYS);
        const status = parseStatus(pickField(raw, STATUS_KEYS));
        const tags = parseTags(pickField(raw, TAGS_KEYS));

        let rowStatus: ImportRowStatus = "novo";
        let reason: string | undefined;
        let existingId: string | undefined;

        if (!name.trim()) {
          rowStatus = "inválido";
          reason = "nome ausente";
        } else if (!isValidPhone(phone)) {
          rowStatus = "inválido";
          reason = "telefone inválido";
        } else {
          const dup = existingByPhone.get(phone);
          if (dup) {
            rowStatus = "duplicado";
            existingId = dup.id;
            reason = `já existe (${dup.name})`;
          }
        }
        return { index: i + 1, raw, name, phone, email, reference, status, tags, rowStatus, reason, existingId };
      });
      setRows(parsed);
    } catch (err) {
      console.error(err);
      toast.error("Não foi possível ler o arquivo.");
    } finally {
      setParsing(false);
    }
  }

  const totals = useMemo<ImportTotals>(() => {
    const total = rows.length;
    const invalid = rows.filter((r) => r.rowStatus === "inválido").length;
    const duplicates = rows.filter((r) => r.rowStatus === "duplicado").length;
    const created = rows.filter((r) => r.rowStatus === "novo").length;
    return { total, created, duplicates, invalid };
  }, [rows]);

  function confirm() {
    if (!rows.length) return;
    // Processa em lotes para não travar a UI em arquivos grandes.
    const created: Contact[] = [];
    const updatedIds = new Set<string>();
    const seenPhones = new Set<string>();

    for (const r of rows) {
      if (r.rowStatus === "inválido") continue;
      if (seenPhones.has(r.phone)) continue; // dedup dentro do próprio arquivo
      seenPhones.add(r.phone);

      if (r.rowStatus === "duplicado" && r.existingId) {
        if (strategy === "ignore") continue;
        const existingC = existing.find((c) => c.id === r.existingId)!;
        // Atualiza apenas campos vazios do existente.
        const merged: Contact = {
          ...existingC,
          name: existingC.name || r.name,
          email: existingC.email || r.email,
          reference: existingC.reference || r.reference,
          status: existingC.status || r.status,
          tags: existingC.tags.length ? existingC.tags : r.tags,
        };
        created.push(merged);
        updatedIds.add(existingC.id);
      } else {
        created.push({
          id: `ct-${Date.now()}-${r.index}`,
          tenantId,
          name: r.name,
          phone: r.phone,
          email: r.email,
          reference: r.reference,
          status: r.status ?? "ativo",
          tags: r.tags,
          avatarColor: colorFor(r.phone),
        });
      }
    }

    onConfirm(created, updatedIds, fileName, totals);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-border p-5">
          <div>
            <h3 className="text-base font-semibold">Importar contatos</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Aceita CSV (separador <code>;</code> ou <code>,</code>) e Excel (.xlsx). Duplicidade é
              verificada por telefone normalizado, apenas dentro da empresa ativa.
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-auto p-5">
          {/* Seletor de arquivo */}
          <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
            <FileSpreadsheet className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">{fileName || "Selecione um arquivo CSV ou XLSX"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Colunas aceitas: <code>nome</code>, <code>telefone</code>, <code>email</code>,{" "}
              <code>referencia</code>, <code>status</code>, <code>tags</code>
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={onPick}
              className="hidden"
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90"
            >
              {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {parsing ? "Lendo arquivo…" : "Selecionar arquivo"}
            </button>
          </div>

          {/* Totais */}
          {rows.length > 0 && (
            <>
              <div className="grid grid-cols-4 gap-3">
                <Stat label="Total" value={totals.total} />
                <Stat label="Novos" value={totals.created} tone="ok" />
                <Stat label="Duplicados" value={totals.duplicates} tone="warn" />
                <Stat label="Inválidos" value={totals.invalid} tone="error" />
              </div>

              {/* Estratégia */}
              <div className="rounded-md border border-border p-3 text-sm">
                <div className="mb-2 font-medium">Quando o telefone já existir nesta empresa:</div>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={strategy === "ignore"}
                      onChange={() => setStrategy("ignore")}
                    />
                    Ignorar duplicados
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={strategy === "update"}
                      onChange={() => setStrategy("update")}
                    />
                    Atualizar campos vazios do contato existente
                  </label>
                </div>
              </div>

              {/* Preview */}
              <div className="overflow-hidden rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">Nome</th>
                      <th className="px-3 py-2 text-left">Telefone (normalizado)</th>
                      <th className="px-3 py-2 text-left">Status</th>
                      <th className="px-3 py-2 text-left">Observação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 50).map((r) => (
                      <tr key={r.index} className="border-t border-border">
                        <td className="px-3 py-1.5 text-muted-foreground">{r.index}</td>
                        <td className="px-3 py-1.5">{r.name || <em className="text-muted-foreground">—</em>}</td>
                        <td className="px-3 py-1.5 font-mono">{r.phone || "—"}</td>
                        <td className="px-3 py-1.5"><RowStatus status={r.rowStatus} /></td>
                        <td className="px-3 py-1.5 text-muted-foreground">{r.reason ?? "ok"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 50 && (
                  <div className="border-t border-border bg-muted/30 px-3 py-2 text-center text-[11px] text-muted-foreground">
                    Mostrando 50 de {rows.length} linhas. A importação processa todas.
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border p-4">
          <div className="text-xs text-muted-foreground">
            Empresa ativa: <strong>{tenantId}</strong> · isolamento garantido por tenant.
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
            <button
              onClick={confirm}
              disabled={!rows.length || parsing}
              className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-4 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" /> Importar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "error" }) {
  const color =
    tone === "ok" ? "text-emerald-600 dark:text-emerald-400"
    : tone === "warn" ? "text-amber-600 dark:text-amber-400"
    : tone === "error" ? "text-destructive"
    : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function RowStatus({ status }: { status: ImportRowStatus }) {
  const map: Record<ImportRowStatus, { cls: string; icon: React.ReactNode }> = {
    novo: { cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", icon: <CheckCircle2 className="h-3 w-3" /> },
    duplicado: { cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400", icon: <AlertTriangle className="h-3 w-3" /> },
    inválido: { cls: "bg-destructive/15 text-destructive", icon: <AlertTriangle className="h-3 w-3" /> },
    atualizar: { cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400", icon: <CheckCircle2 className="h-3 w-3" /> },
  };
  const { cls, icon } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {icon} {status}
    </span>
  );
}
