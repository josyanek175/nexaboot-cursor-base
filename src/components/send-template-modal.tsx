import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import {
  previewAttendanceTemplateBody,
  type AttendanceTemplateVariable,
} from "@/lib/attendance-template";

type TemplateOption = {
  id: string;
  metaTemplateId?: string;
  attendanceTemplateId?: string | null;
  hasOverlay?: boolean;
  name: string;
  description: string | null;
  variables: AttendanceTemplateVariable[];
  body_text?: string | null;
  meta_template_name?: string;
  language_code?: string;
};

type Props = {
  open: boolean;
  conversationId: string;
  contactName?: string | null;
  onClose: () => void;
  onSent: (message: Record<string, unknown>) => void;
};

export function SendTemplateModal({
  open,
  conversationId,
  contactName,
  onClose,
  onSent,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [values, setValues] = useState<Record<number, string>>({});
  const [listContactName, setListContactName] = useState<string>("");

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  const applyList = useCallback(
    (list: TemplateOption[], nameHint: string) => {
      setTemplates(list);
      setListContactName(nameHint);
      if (list[0]) {
        setSelectedId(list[0].id);
        const initial: Record<number, string> = {};
        for (const v of list[0].variables ?? []) {
          initial[v.position] =
            v.source === "customer_name" ? nameHint : "";
        }
        setValues(initial);
      } else {
        setSelectedId("");
        setValues({});
      }
    },
    [],
  );

  const loadTemplates = useCallback(
    async (opts?: { forceSync?: boolean }) => {
      setLoading(true);
      setError(null);
      setSyncFailed(false);
      try {
        const qs = new URLSearchParams({
          conversationId,
        });
        if (opts?.forceSync) qs.set("forceSync", "1");
        const res = await fetch(`/api/attendance/templates?${qs.toString()}`, {
          credentials: "include",
        });
        const j = (await res.json().catch(() => ({}))) as {
          templates?: TemplateOption[];
          contactName?: string | null;
          syncError?: string | null;
          error?: string;
          message?: string;
        };

        if (!res.ok) {
          if (j.error === "sync_failed" || res.status === 502) {
            setSyncFailed(true);
            setTemplates([]);
            setSelectedId("");
            setValues({});
            setError(
              j.message ?? "Não foi possível atualizar os templates da Meta.",
            );
            return;
          }
          throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
        }

        const list = j.templates ?? [];
        const name = String(j.contactName ?? contactName ?? "").trim();
        applyList(list, name);

        if (j.syncError && list.length > 0) {
          setError("Não foi possível atualizar os templates da Meta.");
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [applyList, contactName, conversationId],
  );

  useEffect(() => {
    if (!open) return;
    void loadTemplates();
  }, [open, loadTemplates]);

  function selectTemplate(id: string) {
    setSelectedId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const name = listContactName || String(contactName ?? "").trim();
    const initial: Record<number, string> = {};
    for (const v of t.variables ?? []) {
      initial[v.position] =
        v.source === "customer_name" ? name : "";
    }
    setValues(initial);
  }

  const preview = useMemo(() => {
    if (!selected?.body_text) return "";
    return previewAttendanceTemplateBody(selected.body_text, values);
  }, [selected, values]);

  const canSend = useMemo(() => {
    if (!selected || sending) return false;
    for (const v of selected.variables ?? []) {
      if (v.required && !String(values[v.position] ?? "").trim()) return false;
    }
    return true;
  }, [selected, values, sending]);

  async function handleSend() {
    if (!selected || !canSend) return;
    setSending(true);
    setError(null);
    try {
      const variableValues: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        variableValues[String(k)] = v;
      }
      const metaTemplateId = selected.metaTemplateId ?? selected.id;
      const res = await fetch("/api/messages/send-template", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          metaTemplateId,
          attendanceTemplateId: selected.attendanceTemplateId ?? null,
          variableValues,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: Record<string, unknown> | string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(
          typeof j.message === "string"
            ? j.message
            : j.error ?? `HTTP ${res.status}`,
        );
      }
      if (j.message && typeof j.message === "object") {
        onSent(j.message);
      } else {
        onSent({});
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border border-border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Enviar template WhatsApp</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-muted"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Sincronizando templates da Meta...
            </div>
          ) : syncFailed ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Não foi possível atualizar os templates da Meta.
              </p>
              <button
                type="button"
                onClick={() => void loadTemplates({ forceSync: true })}
                className="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-muted"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Tentar novamente
              </button>
            </div>
          ) : templates.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Não encontramos templates aprovados para este número na Meta.
              </p>
              <button
                type="button"
                onClick={() => void loadTemplates({ forceSync: true })}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                <RefreshCw className="h-3 w-3" />
                Atualizar templates
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <label className="block min-w-0 flex-1 text-xs">
                  <span className="mb-1 block font-medium text-muted-foreground">
                    Template
                  </span>
                  <select
                    value={selectedId}
                    onChange={(e) => selectTemplate(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void loadTemplates({ forceSync: true })}
                  disabled={loading}
                  className="mt-5 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Forçar sincronização com a Meta"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Atualizar templates
                </button>
              </div>

              {selected?.description && (
                <p className="text-xs text-muted-foreground">{selected.description}</p>
              )}

              {!selected?.hasOverlay && selected?.meta_template_name && (
                <p className="text-xs text-muted-foreground">
                  Template Meta: {selected.meta_template_name}
                </p>
              )}

              {(selected?.variables ?? []).map((v) => (
                <label key={v.position} className="block text-xs">
                  <span className="mb-1 block font-medium text-muted-foreground">
                    {v.label}
                    {v.required ? " *" : ""}
                  </span>
                  {v.type === "textarea" ? (
                    <textarea
                      rows={3}
                      value={values[v.position] ?? ""}
                      onChange={(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [v.position]: e.target.value,
                        }))
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    />
                  ) : (
                    <input
                      type="text"
                      value={values[v.position] ?? ""}
                      onChange={(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [v.position]: e.target.value,
                        }))
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    />
                  )}
                </label>
              ))}

              <div className="rounded-md border border-border bg-muted/30 p-3">
                <p className="mb-1 text-xs font-medium text-muted-foreground">Prévia</p>
                <pre className="whitespace-pre-wrap text-sm">
                  {preview || "—"}
                </pre>
              </div>
            </>
          )}

          {error && !syncFailed && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-input px-3 py-2 text-sm hover:bg-muted"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!canSend || templates.length === 0 || syncFailed || loading}
            onClick={handleSend}
            className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-50"
          >
            {sending && <Loader2 className="h-4 w-4 animate-spin" />}
            Enviar template
          </button>
        </div>
      </div>
    </div>
  );
}
