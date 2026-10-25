import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { isPlatformRole } from "@/lib/platform-roles";
type Named = { id: string; name: string | null };
type Access = {
  users: Named[];
  channels: Named[];
  teams: Named[];
  members: { team_id: string; user_id: string }[];
  grants: { id: string; channel_id: string; user_id: string | null; team_id: string | null }[];
};
export const Route = createFileRoute("/_app/equipes-numeros")({ component: Page });
function Page() {
  const { user, companyValid } = useAuth();
  const allowed =
    isPlatformRole(user?.role) || ["ADMIN_EMPRESA", "GERENTE"].includes(user?.role ?? "");
  const [data, setData] = useState<Access>({
    users: [],
    channels: [],
    teams: [],
    members: [],
    grants: [],
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const [member, setMember] = useState("");
  const [target, setTarget] = useState("");
  const [channel, setChannel] = useState("");
  async function load() {
    const r = await fetch("/api/team-access");
    if (!r.ok)
      throw Error("Não foi possível carregar. Confirme a migração de operações da empresa.");
    setData(await r.json());
  }
  useEffect(() => {
    if (allowed && companyValid) void load().catch((e) => setMessage(e.message));
  }, [allowed, companyValid]);
  async function action(body: object) {
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/team-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw Error("Não foi possível salvar. Confira os dados e as permissões.");
      await load();
      setMessage("Alteração salva.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const lookup = (list: Named[], id: string | null) =>
    list.find((x) => x.id === id)?.name ?? id ?? "";
  const select = (
    value: string,
    set: (v: string) => void,
    options: Named[],
    placeholder: string,
  ) => (
    <select
      required
      className="rounded border p-2"
      value={value}
      onChange={(e) => set(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name ?? o.id}
        </option>
      ))}
    </select>
  );
  if (!allowed) return <div className="p-6">Acesso exclusivo da gerência e administração.</div>;
  if (!companyValid) return <div className="p-6">Selecione uma empresa.</div>;
  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="text-xl font-semibold">Equipes e números</h1>
      <p className="mt-2 text-sm">
        As liberações individuais se somam às liberações de todas as equipes do usuário. Ative a
        restrição em Configurações após cadastrar os acessos.
      </p>
      <p role="status" className="my-3">
        {message}
      </p>
      <fieldset disabled={busy} className="space-y-8 disabled:opacity-50">
        <section>
          <h2 className="font-semibold">Nova equipe</h2>
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void action({ action: "team", name });
            }}
          >
            <input
              required
              maxLength={120}
              className="rounded border p-2"
              placeholder="Nome da equipe"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="rounded border px-3">Criar equipe</button>
          </form>
        </section>
        <section>
          <h2 className="font-semibold">Membros</h2>
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void action({ action: "member", teamId: team, userId: member });
            }}
          >
            {select(team, setTeam, data.teams, "Equipe")}
            {select(member, setMember, data.users, "Usuário")}
            <button className="rounded border px-3">Adicionar membro</button>
          </form>
          <ul className="mt-3 space-y-2">
            {data.members.map((m) => (
              <li key={m.team_id + m.user_id} className="flex gap-3">
                {lookup(data.teams, m.team_id)} · {lookup(data.users, m.user_id)}
                <button
                  className="text-red-700"
                  onClick={() =>
                    void action({ action: "remove_member", teamId: m.team_id, userId: m.user_id })
                  }
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="font-semibold">Liberar número</h2>
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const [kind, id] = target.split(":");
              void action({
                action: "grant",
                channelId: channel,
                [kind === "user" ? "userId" : "teamId"]: id,
              });
            }}
          >
            {select(channel, setChannel, data.channels, "Número")}
            {select(
              target,
              setTarget,
              [
                ...data.users.map((x) => ({
                  ...x,
                  id: "user:" + x.id,
                  name: "Usuário: " + x.name,
                })),
                ...data.teams.map((x) => ({ ...x, id: "team:" + x.id, name: "Equipe: " + x.name })),
              ],
              "Usuário ou equipe",
            )}
            <button className="rounded border px-3">Liberar</button>
          </form>
          <ul className="mt-3 space-y-2">
            {data.grants.map((g) => (
              <li key={g.id} className="flex gap-3">
                {lookup(data.channels, g.channel_id)} →{" "}
                {g.user_id ? lookup(data.users, g.user_id) : lookup(data.teams, g.team_id)}
                <button
                  className="text-red-700"
                  onClick={() => void action({ action: "revoke", grantId: g.id })}
                >
                  Revogar
                </button>
              </li>
            ))}
          </ul>
        </section>
      </fieldset>
    </div>
  );
}
