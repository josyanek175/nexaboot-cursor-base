import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
export const Route = createFileRoute("/redefinir-senha")({
  component: ResetPage,
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
});
function ResetPage() {
  const [token, setToken] = useState(""),
    [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  useEffect(() => {
    const value = window.location.hash.slice(1);
    setToken(value);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  return (
    <main className="grid min-h-screen place-items-center bg-muted p-5">
      <div className="w-full max-w-md rounded-xl border bg-card p-6">
        <h1 className="text-xl font-semibold">Escolha uma nova senha</h1>
        {done ? (
          <p className="mt-4">
            Senha alterada.{" "}
            <Link to="/login" className="underline">
              Voltar para entrar
            </Link>
          </p>
        ) : (
          <form
            className="mt-5 space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (password !== confirmation) {
                setMessage("As senhas não coincidem.");
                return;
              }
              setBusy(true);
              setMessage("");
              try {
                const r = await fetch("/api/auth/password-recovery", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ token, password }),
                });
                const data = await r.json();
                if (!r.ok)
                  throw Error(
                    data.message ??
                      "Confira o link e use uma senha com pelo menos 10 caracteres e até 72 bytes.",
                  );
                setDone(true);
                setPassword("");
                setConfirmation("");
                setToken("");
              } catch (e) {
                setMessage((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="block">
              Nova senha
              <input
                required
                type="password"
                minLength={10}
                autoComplete="new-password"
                className="mt-1 w-full rounded border p-2"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="block">
              Confirme a senha
              <input
                required
                type="password"
                minLength={10}
                autoComplete="new-password"
                className="mt-1 w-full rounded border p-2"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !token}
              className="w-full rounded bg-emerald-700 p-2 text-white disabled:opacity-40"
            >
              {busy ? "Alterando…" : "Alterar senha"}
            </button>
            <p role="status">
              {message ||
                (!token
                  ? "Abra o link recebido por e-mail."
                  : "O link pode ser usado uma única vez.")}
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
