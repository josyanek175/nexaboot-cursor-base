import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Users as UsersIcon, X, Check, Pencil, Power, Trash2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { users as allUsers } from "@/lib/mocks";
import { useCurrentUser, canManageInternalGroups } from "@/lib/current-user";
import {
  ensureDefaultGroups,
  listGroups,
  createGroup,
  updateGroup,
  toggleGroupActive,
  addMembers,
  removeMember,
  subscribeGroups,
  type InternalGroup,
} from "@/lib/internal-groups-store";

export const Route = createFileRoute("/_app/grupos-internos")({
  component: GruposInternosPage,
  head: () => ({
    meta: [
      { title: "Grupos Internos — NexaBoot" },
      { name: "description", content: "Gerencie grupos internos da empresa." },
    ],
  }),
});

function GruposInternosPage() {
  const me = useCurrentUser();
  const canManage = canManageInternalGroups(me?.role);

  // 1) Sempre chamamos hooks na mesma ordem. Sem `me` mantemos placeholders.
  const tenantId = me?.tenant_id ?? "";
  const [groups, setGroups] = useState<InternalGroup[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<InternalGroup | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!tenantId) return;
    ensureDefaultGroups(tenantId);
    const refresh = () => setGroups(listGroups(tenantId));
    refresh();
    return subscribeGroups(tenantId, refresh);
  }, [tenantId]);

  const filtered = useMemo(
    () => groups.filter((g) => g.name.toLowerCase().includes(query.toLowerCase())),
    [groups, query],
  );

  // 2) Só depois redirecionamos / bloqueamos. Os hooks acima já rodaram.
  if (!me) return <Navigate to="/login" />;
  if (!canManage) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-card p-6 text-center">
          <ShieldAlert className="h-10 w-10 text-destructive" />
          <h1 className="text-lg font-semibold">Acesso restrito</h1>
          <p className="text-sm text-muted-foreground">
            Apenas administradores podem gerenciar grupos internos.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-3 pl-12 lg:pl-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">Grupos Internos</h1>
          <p className="truncate text-xs text-muted-foreground">{me.tenant_name}</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Novo grupo
        </button>
      </header>

      <div className="border-b border-border bg-background px-4 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar grupo..."
            className="w-full rounded-md border border-input bg-card py-2 pl-8 pr-3 text-sm"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {filtered.length === 0 ? (
          <div className="grid place-items-center py-16 text-sm text-muted-foreground">
            Nenhum grupo encontrado.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                onEdit={() => setEditing(g)}
                onToggle={() => {
                  const updated = toggleGroupActive(tenantId, g.id);
                  toast.success(updated?.active ? "Grupo ativado" : "Grupo inativado");
                }}
              />
            ))}
          </div>
        )}
      </div>

      {(creating || editing) && (
        <GroupModal
          tenantId={tenantId}
          group={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function GroupCard({
  group,
  onEdit,
  onToggle,
}: {
  group: InternalGroup;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const active = group.active ?? true;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{group.name}</h3>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                active
                  ? "bg-emerald-500/10 text-emerald-600"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {active ? "ativo" : "inativo"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {group.type === "group" ? "Grupo" : group.type === "broadcast" ? "Avisos" : "Direta"}
          </p>
        </div>
      </div>
      {group.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">{group.description}</p>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <UsersIcon className="h-3.5 w-3.5" />
        {group.memberIds.length} membro{group.memberIds.length === 1 ? "" : "s"}
      </div>
      <div className="mt-auto flex gap-2 pt-2">
        <button
          onClick={onEdit}
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-accent"
        >
          <Pencil className="h-3.5 w-3.5" /> Editar
        </button>
        <button
          onClick={onToggle}
          className="inline-flex items-center justify-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-accent"
        >
          <Power className="h-3.5 w-3.5" /> {active ? "Inativar" : "Ativar"}
        </button>
      </div>
    </div>
  );
}

function GroupModal({
  tenantId,
  group,
  onClose,
}: {
  tenantId: string;
  group: InternalGroup | null;
  onClose: () => void;
}) {
  const isEdit = !!group;
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [selected, setSelected] = useState<string[]>(group?.memberIds ?? []);
  const [search, setSearch] = useState("");

  const tenantUsers = useMemo(
    () => allUsers.filter((u) => u.tenantId === tenantId),
    [tenantId],
  );
  const searchable = useMemo(
    () =>
      tenantUsers.filter((u) =>
        (u.name + " " + u.email).toLowerCase().includes(search.toLowerCase()),
      ),
    [tenantUsers, search],
  );

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function save() {
    const n = name.trim();
    if (!n) {
      toast.error("Informe o nome do grupo");
      return;
    }
    if (selected.length === 0) {
      toast.error("Selecione ao menos 1 membro");
      return;
    }
    if (isEdit && group) {
      updateGroup(tenantId, group.id, { name: n, description, memberIds: selected });
      toast.success("Grupo atualizado");
    } else {
      createGroup({ tenantId, name: n, description, memberIds: selected, type: "group" });
      toast.success("Grupo criado");
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">{isEdit ? "Editar grupo" : "Novo grupo"}</h3>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-auto p-4">
          <div>
            <label className="mb-1 block text-xs font-medium">Nome</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Financeiro"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Descrição (opcional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">
              Membros ({selected.length} selecionado{selected.length === 1 ? "" : "s"})
            </label>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar usuário..."
                className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-sm"
              />
            </div>
            <div className="max-h-60 space-y-1 overflow-auto rounded-md border border-border p-1">
              {searchable.length === 0 ? (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  Nenhum usuário encontrado.
                </div>
              ) : (
                searchable.map((u) => {
                  const checked = selected.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      onClick={() => toggle(u.id)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${
                        checked ? "bg-accent/60" : ""
                      }`}
                    >
                      <div
                        className="grid h-7 w-7 place-items-center rounded-full text-xs font-semibold text-white"
                        style={{ backgroundColor: u.avatarColor }}
                      >
                        {u.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{u.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                      </div>
                      {checked && <Check className="h-4 w-4 text-primary" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
          {isEdit && group && group.memberIds.length > 0 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Remoção rápida
              </label>
              <div className="flex flex-wrap gap-1">
                {group.memberIds.map((id) => {
                  const u = allUsers.find((x) => x.id === id);
                  if (!u) return null;
                  return (
                    <button
                      key={id}
                      onClick={() => {
                        removeMember(tenantId, group.id, id);
                        setSelected((prev) => prev.filter((x) => x !== id));
                      }}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] hover:bg-destructive/10"
                    >
                      {u.name} <Trash2 className="h-3 w-3" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-background px-3 py-2 text-xs hover:bg-accent"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            {isEdit ? "Salvar alterações" : "Criar grupo"}
          </button>
        </div>
      </div>
    </div>
  );
}
