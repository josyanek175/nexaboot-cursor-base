import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { canManageInternalGroups } from "@/lib/current-user";
type Group = { id: string; name: string; active: boolean; member_ids: string[] };
type Member = { id: string; name: string };
export const Route = createFileRoute("/_app/grupos-internos")({ component: Page });
function Page() {
  const { user, companyValid, companyName } = useAuth();
  const allowed = canManageInternalGroups(user?.role);
  const [groups, setGroups] = useState<Group[]>([]),
    [members, setMembers] = useState<Member[]>([]),
    [draft, setDraft] = useState<Group | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    const [a, b] = await Promise.all([
      fetch("/api/internal-groups"),
      fetch("/api/internal-chat/users"),
    ]);
    if (!a.ok || !b.ok)
      throw Error(
        "Não foi possível carregar os grupos. Confirme a migração de operações da empresa.",
      );
    setGroups((await a.json()).groups);
    setMembers((await b.json()).users);
  }
  useEffect(() => {
    if (allowed && companyValid) void load().catch((e) => setMessage(e.message));
  }, [allowed, companyValid]);
  if (!allowed)
    return <div className="p-6">Apenas administradores podem gerenciar grupos internos.</div>;
  if (!companyValid) return <div className="p-6">Selecione uma empresa.</div>;
  return (
    <div className="h-full min-w-0 overflow-auto p-3 sm:p-6">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Grupos internos</h1>
          <p>{companyName}</p>
        </div>
        <button
          className="rounded border px-3"
          onClick={() =>
            setDraft({ id: "", name: "", active: true, member_ids: user ? [user.id] : [] })
          }
        >
          Novo grupo
        </button>
      </header>
      <p role="status" className="my-4">
        {message}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map((g) => (
          <div key={g.id} className="min-w-0 rounded border p-4 [overflow-wrap:anywhere]">
            <h2 className="font-semibold">{g.name}</h2>
            <p className="my-2">
              {g.member_ids.length} membros · {g.active ? "Ativo" : "Inativo"}
            </p>
            <button className="underline" onClick={() => setDraft(g)}>
              Editar grupo
            </button>
          </div>
        ))}
      </div>
      {draft && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <form
            className="max-h-[calc(100dvh-2rem)] w-full max-w-lg space-y-4 overflow-auto rounded-xl bg-card p-4 sm:p-6"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setMessage("");
              try {
                const r = await fetch(
                  draft.id ? "/api/internal-groups" : "/api/internal-chat/create",
                  {
                    method: draft.id ? "PATCH" : "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(
                      draft.id
                        ? {
                            id: draft.id,
                            name: draft.name,
                            active: draft.active,
                            memberIds: draft.member_ids,
                          }
                        : { title: draft.name, type: "group", memberIds: draft.member_ids },
                    ),
                  },
                );
                if (!r.ok)
                  throw Error(
                    "Não foi possível salvar. Selecione ao menos outro membro ativo da empresa.",
                  );
                setDraft(null);
                await load();
                setMessage("Grupo salvo e disponível na Comunicação Interna.");
              } catch (e) {
                setMessage((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <h2 className="font-semibold">{draft.id ? "Editar grupo" : "Novo grupo"}</h2>
            <label className="block">
              Nome
              <input
                className="mt-1 w-full rounded border p-2"
                required
                maxLength={120}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            {draft.id && (
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                />
                Grupo ativo
              </label>
            )}
            <fieldset disabled={busy}>
              <legend>Membros da empresa</legend>
              {members
                .filter((m) => m.id !== user?.id)
                .map((m) => (
                  <label key={m.id} className="mt-2 flex gap-2">
                    <input
                      type="checkbox"
                      checked={draft.member_ids.includes(m.id)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          member_ids: e.target.checked
                            ? [...draft.member_ids, m.id]
                            : draft.member_ids.filter((id) => id !== m.id),
                        })
                      }
                    />
                    {m.name}
                  </label>
                ))}
            </fieldset>
            <p role="status">{message}</p>
            <div className="flex gap-3">
              <button disabled={busy} className="rounded bg-emerald-700 px-4 py-2 text-white">
                {busy ? "Salvando…" : "Salvar"}
              </button>
              <button type="button" disabled={busy} onClick={() => setDraft(null)}>
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
