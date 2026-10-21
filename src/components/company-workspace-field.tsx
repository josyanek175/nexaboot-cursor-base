import { useState } from "react";
import { toast } from "sonner";

export function CompanyWorkspaceField({
  companyId,
  slug,
  editable,
  onSaved,
}: {
  companyId: string;
  slug?: string | null;
  editable: boolean;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState(slug ?? "");
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      const response = await fetch(`/api/companies/${companyId}/workspace`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: value }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Não foi possível salvar o endereço.");
      toast.success("Endereço da empresa salvo.");
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mt-2 space-y-1 text-xs font-normal">
      {slug && (
        <a
          className="block text-primary underline underline-offset-2"
          href={`/${slug}`}
          target="_blank"
          rel="noreferrer"
        >
          Abrir /{slug}
        </a>
      )}
      {editable && (
        <div className="flex max-w-xs gap-1">
          <input
            aria-label="Endereço exclusivo da empresa"
            placeholder="empresa1"
            value={value}
            maxLength={48}
            onChange={(event) => setValue(event.target.value.toLowerCase())}
            className="min-w-0 rounded border border-input bg-background px-2 py-1"
          />
          <button
            type="button"
            onClick={save}
            disabled={saving || value === (slug ?? "")}
            className="rounded border px-2 py-1 disabled:opacity-40"
          >
            {saving ? "Salvando…" : "Salvar endereço"}
          </button>
        </div>
      )}
    </div>
  );
}
