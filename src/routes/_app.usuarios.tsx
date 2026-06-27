import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Users as UsersIcon, Plus, Pencil, Lock, Unlock, Trash2,
  ShieldAlert, X, MoreHorizontal, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type DbUser = {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  avatar_url: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

const ROLES = ["ADMIN", "USER", "ADMIN_EMPRESA", "GERENTE", "SUPERVISOR", "ATENDENTE", "TI"];
const ADMIN_ROLES = new Set(["ADMIN", "ADMIN_GERAL", "ADMIN_EMPRESA", "TI"]);

export const Route = createFileRoute("/_app/usuarios")({
  component: UsuariosPage,
});

function UsuariosPage() {
  const { user: me } = useAuth();
  const canManage = !!me && ADMIN_ROLES.has(String(me.role));

  const [items, setItems] = useState<DbUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [confirm, setConfirm] = useState<null | {
    title: string; desc: string; cta: string; variant: "warn" | "danger";
    onConfirm: () => Promise<void> | void;
  }>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/users", { credentials: "include" });
      if (res.status === 401) { setError("Faça login novamente."); setItems([]); return; }
      if (res.status === 403) { setError("Sem permissão para listar usuários."); setItems([]); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { users: DbUser[] };
      setItems(data.users || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  if (!canManage) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <ShieldAlert className="mx-auto mb-2 h-8 w-8 text-destructive" />
          <h2 className="text-lg font-semibold">Acesso restrito</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Seu perfil <b>{me?.role ?? "—"}</b> não tem permissão para acessar a gestão de usuários.
          </p>
        </div>
      </div>
    );
  }

  function openNew() {
    setEditing({
      mode: "create",
      id: null,
      name: "", email: "", role: "USER", active: true,
      password: "",
    });
    setEditOpen(true);
  }
  function openEdit(u: DbUser) {
    setEditing({
      mode: "edit",
      id: u.id,
      name: u.name, email: u.email, role: u.role, active: u.active,
      password: "",
    });
    setEditOpen(true);
  }

  async function save() {
    if (!editing) return;
    const name = editing.name.trim();
    const email = editing.email.trim().toLowerCase();
    if (name.length < 2) { toast.error("Informe um nome válido"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast.error("E-mail inválido"); return; }
    if (editing.mode === "create" && editing.password.length < 6) {
      toast.error("Senha deve ter pelo menos 6 caracteres"); return;
    }
    if (editing.mode === "edit" && editing.password && editing.password.length < 6) {
      toast.error("Nova senha deve ter pelo menos 6 caracteres"); return;
    }

    try {
      let res: Response;
      if (editing.mode === "create") {
        res = await fetch("/api/users", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name, email, role: editing.role, active: editing.active,
            password: editing.password,
          }),
        });
      } else {
        res = await fetch(`/api/users/${editing.id}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name, email, role: editing.role, active: editing.active,
            password: editing.password ? editing.password : null,
          }),
        });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || `Falha (${res.status})`);
        return;
      }
      toast.success(editing.mode === "create" ? "Usuário criado" : "Usuário atualizado");
      setEditOpen(false);
      reload();
    } catch (e) {
      toast.error("Falha de conexão");
    }
  }

  function toggleActive(u: DbUser) {
    setConfirm({
      title: u.active ? "Inativar usuário?" : "Ativar usuário?",
      desc: u.active
        ? `${u.name} perderá acesso imediato ao sistema.`
        : `${u.name} voltará a ter acesso.`,
      cta: u.active ? "Inativar" : "Ativar", variant: "warn",
      onConfirm: async () => {
        const res = await fetch(`/api/users/${u.id}`, {
          method: "PUT", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: !u.active }),
        });
        if (!res.ok) { toast.error("Falha ao atualizar"); return; }
        toast.success(u.active ? "Usuário inativado" : "Usuário ativado");
        setConfirm(null);
        reload();
      },
    });
  }
  function deleteUser(u: DbUser) {
    setConfirm({
      title: "Inativar usuário (exclusão lógica)?",
      desc: `Remove o acesso de ${u.name}. O histórico será preservado para auditoria.`,
      cta: "Inativar definitivamente", variant: "danger",
      onConfirm: async () => {
        const res = await fetch(`/api/users/${u.id}`, {
          method: "DELETE", credentials: "include",
        });
        if (!res.ok) { toast.error("Falha ao excluir"); return; }
        toast.success(`${u.name} foi inativado`);
        setConfirm(null);
        reload();
      },
    });
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <UsersIcon className="h-5 w-5 text-whatsapp" />
          <div>
            <h1 className="text-lg font-semibold">Usuários e Perfis</h1>
            <p className="text-xs text-muted-foreground">
              Logado como <b>{me?.name}</b> ({me?.role}) · tenant {me?.tenantId}
            </p>
          </div>
        </div>
        <button
          onClick={openNew}
          className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Novo usuário
        </button>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left">Usuário</th>
                <th className="px-4 py-3 text-left">E-mail</th>
                <th className="px-4 py-3 text-left">Perfil</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td></tr>
              )}
              {!loading && items.map((u) => (
                <tr key={u.id} className="border-t border-border hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`grid h-8 w-8 place-items-center rounded-full text-xs font-semibold text-white ${
                          !u.active ? "opacity-40 grayscale" : ""
                        }`}
                        style={{ backgroundColor: "#00a884" }}
                      >
                        {u.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?"}
                      </div>
                      <span className={`font-medium ${!u.active ? "text-muted-foreground line-through" : ""}`}>
                        {u.name || "—"}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                  <td className="px-4 py-3"><span className="rounded-md bg-accent px-2 py-1 text-xs">{u.role}</span></td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs ${u.active ? "text-whatsapp" : "text-muted-foreground"}`}>
                      <span className={`h-2 w-2 rounded-full ${u.active ? "bg-whatsapp" : "bg-muted-foreground"}`} />
                      {u.active ? "Ativo" : "Inativo"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-medium hover:bg-accent">
                            <MoreHorizontal className="h-4 w-4" /> Ações
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuLabel className="text-xs">Gerenciar usuário</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => openEdit(u)}>
                            <Pencil className="mr-2 h-4 w-4" /> Editar usuário
                          </DropdownMenuItem>
                          {u.active ? (
                            <DropdownMenuItem onClick={() => toggleActive(u)}>
                              <Lock className="mr-2 h-4 w-4 text-amber-600" /> Inativar
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => toggleActive(u)}>
                              <Unlock className="mr-2 h-4 w-4 text-whatsapp" /> Ativar
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => deleteUser(u)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" /> Excluir (lógico)
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && items.length === 0 && !error && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">Nenhum usuário cadastrado</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editOpen && editing && (
        <EditModal
          draft={editing}
          onChange={setEditing}
          onClose={() => setEditOpen(false)}
          onSave={save}
        />
      )}

      {confirm && <ConfirmModal {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

type EditDraft = {
  mode: "create" | "edit";
  id: string | null;
  name: string;
  email: string;
  role: string;
  active: boolean;
  password: string;
};

function EditModal({ draft, onChange, onClose, onSave }: {
  draft: EditDraft;
  onChange: (d: EditDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <ModalShell title={draft.mode === "create" ? "Novo usuário" : "Editar usuário"} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nome" value={draft.name} onChange={(v) => onChange({ ...draft, name: v })} />
          <Field label="E-mail" value={draft.email} onChange={(v) => onChange({ ...draft, email: v })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Perfil" value={draft.role} options={ROLES}
            onChange={(v) => onChange({ ...draft, role: v })} />
          <Select label="Status" value={draft.active ? "ATIVO" : "INATIVO"} options={["ATIVO", "INATIVO"]}
            onChange={(v) => onChange({ ...draft, active: v === "ATIVO" })} />
        </div>
        <Field
          label={draft.mode === "create" ? "Senha" : "Nova senha (deixe vazio para manter)"}
          type="password"
          value={draft.password}
          onChange={(v) => onChange({ ...draft, password: v })}
        />
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
        <button onClick={onSave} className="rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90">
          Salvar
        </button>
      </div>
    </ModalShell>
  );
}

function ConfirmModal({ title, desc, cta, variant, onConfirm, onClose }: {
  title: string; desc: string; cta: string; variant: "warn" | "danger";
  onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const isDanger = variant === "danger";
  const [busy, setBusy] = useState(false);
  return (
    <ModalShell title={title} onClose={onClose}>
      <p className="text-sm text-muted-foreground">{desc}</p>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md px-3 py-2 text-sm hover:bg-accent">Cancelar</button>
        <button
          disabled={busy}
          onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}
          className={`rounded-md px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 ${
            isDanger ? "bg-destructive" : "bg-amber-600"
          }`}
        >
          {cta}
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp" />
    </label>
  );
}

function Select({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp">
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
