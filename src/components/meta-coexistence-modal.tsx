/**
 * Modal — Meta Coexistence via Embedded Signup oficial.
 * Fluxo: start → FB.login → complete(code+state). Token nunca no frontend.
 * Não substitui MetaTokenModal (Cloud API tradicional).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { apiPost } from "@/lib/api";

type FlowState =
  | "idle"
  | "iniciando"
  | "aguardando_confirmacao"
  | "validando"
  | "conectado"
  | "erro";

type StartPayload = {
  ok?: boolean;
  ready?: boolean;
  state?: string;
  appId?: string | null;
  configId?: string | null;
  graphVersion?: string;
  migrationApplied?: boolean;
};

type SessionInfo = {
  waba_id?: string;
  phone_number_id?: string;
  business_id?: string;
  display_phone_number?: string;
};

declare global {
  interface Window {
    FB?: {
      init: (opts: Record<string, unknown>) => void;
      login: (
        cb: (response: { authResponse?: { code?: string } }) => void,
        opts: Record<string, unknown>,
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

function loadFacebookSdk(appId: string, graphVersion: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.FB) {
      window.FB.init({
        appId,
        cookie: true,
        xfbml: false,
        version: graphVersion,
      });
      resolve();
      return;
    }

    window.fbAsyncInit = () => {
      window.FB?.init({
        appId,
        cookie: true,
        xfbml: false,
        version: graphVersion,
      });
      resolve();
    };

    if (document.getElementById("facebook-jssdk")) return;

    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.onerror = () => reject(new Error("Falha ao carregar Facebook SDK"));
    document.body.appendChild(script);
  });
}

const STATE_LABEL: Record<FlowState, string> = {
  idle: "Pronto para conectar",
  iniciando: "Iniciando…",
  aguardando_confirmacao: "Aguardando confirmação na Meta…",
  validando: "Validando e registrando canal…",
  conectado: "Conectado",
  erro: "Erro na conexão",
};

export function MetaCoexistenceModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState<{
    waba_id?: string;
    phone_number_id?: string;
    display_phone_number?: string | null;
    verified_name?: string | null;
    webhook_subscription_status?: string;
  } | null>(null);

  const sessionInfoRef = useRef<SessionInfo>({});
  const startRef = useRef<StartPayload | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (typeof event.origin !== "string" || !event.origin.includes("facebook.com")) return;
      let payload: unknown = event.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }
      const rec = payload as Record<string, unknown> | null;
      if (!rec || rec.type !== "WA_EMBEDDED_SIGNUP") return;
      const data = (rec.data ?? {}) as Record<string, unknown>;
      sessionInfoRef.current = {
        waba_id: typeof data.waba_id === "string" ? data.waba_id : undefined,
        phone_number_id:
          typeof data.phone_number_id === "string" ? data.phone_number_id : undefined,
        business_id: typeof data.business_id === "string" ? data.business_id : undefined,
        display_phone_number:
          typeof data.display_phone_number === "string"
            ? data.display_phone_number
            : undefined,
      };
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const runStart = useCallback(async () => {
    setFlowState("iniciando");
    setErrorMessage(null);
    setSummary(null);
    try {
      const data = (await apiPost("/meta/embedded-signup/start", {})) as StartPayload;
      startRef.current = data;
      if (!data.appId || !data.configId || !data.state) {
        throw new Error(
          "Embedded Signup incompleto: configure META_APP_ID e META_EMBEDDED_SIGNUP_CONFIG_ID no DEV.",
        );
      }
      if (!data.migrationApplied || data.ready === false) {
        throw new Error(
          "Migrations Coexistence ainda não aplicadas ou App/Config ID ausentes no ambiente.",
        );
      }
      await loadFacebookSdk(String(data.appId), String(data.graphVersion || "v21.0"));
      setFlowState("idle");
      return data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Falha ao iniciar Embedded Signup";
      setErrorMessage(msg);
      setFlowState("erro");
      toast.error(msg);
      return null;
    }
  }, []);

  useEffect(() => {
    void runStart();
  }, [runStart]);

  async function connectExistingNumber() {
    let start = startRef.current;
    if (!start?.state || !start.appId || !start.configId) {
      start = await runStart();
      if (!start?.state || !start.appId || !start.configId) return;
    }
    if (!window.FB) {
      setErrorMessage("Facebook SDK não carregou");
      setFlowState("erro");
      return;
    }

    setFlowState("aguardando_confirmacao");
    setErrorMessage(null);

    try {
      const code = await new Promise<string>((resolve, reject) => {
        window.FB!.login(
          (response) => {
            const authCode = response.authResponse?.code;
            if (!authCode) {
              reject(new Error("Embedded Signup cancelado ou sem código temporário"));
              return;
            }
            resolve(authCode);
          },
          {
            config_id: start!.configId,
            response_type: "code",
            override_default_response_type: true,
            extras: {
              setup: {},
              featureType: "whatsapp_business_app_onboarding",
              sessionInfoVersion: "3",
            },
          },
        );
      });

      setFlowState("validando");

      // Code sobe só nesta request — não fica em state React.
      const result = await apiPost("/meta/embedded-signup/complete", {
        code,
        state: start.state,
        session_info: Object.keys(sessionInfoRef.current).length
          ? sessionInfoRef.current
          : undefined,
        name: name.trim() || undefined,
      });

      startRef.current = null;
      setSummary({
        waba_id: result.assets?.waba_id,
        phone_number_id: result.assets?.phone_number_id,
        display_phone_number: result.assets?.display_phone_number,
        verified_name: result.assets?.verified_name,
        webhook_subscription_status: result.webhook_subscription_status,
      });
      setFlowState("conectado");
      toast.success("Número conectado em coexistência");
      onConnected();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Falha ao completar Embedded Signup";
      setErrorMessage(msg);
      setFlowState("erro");
      toast.error(msg);
      // Renova CSRF para nova tentativa
      void runStart();
    }
  }

  const busy =
    flowState === "iniciando" ||
    flowState === "aguardando_confirmacao" ||
    flowState === "validando";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Conectar número existente em coexistência</h2>
            <p className="text-[11px] text-muted-foreground">
              WhatsApp Business App + Cloud API · Embedded Signup oficial
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 hover:bg-accent"
            aria-label="Fechar"
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div
            className={`rounded-md border px-3 py-2 text-xs ${
              flowState === "erro"
                ? "border-destructive/40 bg-destructive/5 text-destructive"
                : flowState === "conectado"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                  : "border-border bg-muted/40 text-muted-foreground"
            }`}
          >
            <span className="font-medium text-foreground">Status:</span> {STATE_LABEL[flowState]}
            {busy && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin" />}
          </div>

          {errorMessage && (
            <p className="text-xs text-destructive">{errorMessage}</p>
          )}

          <label className="block text-xs font-medium">
            Nome do canal (opcional)
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy || flowState === "conectado"}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-50"
              placeholder="Atendimento Coexistence"
            />
          </label>

          {summary && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs space-y-1">
              {summary.verified_name && (
                <p>
                  <span className="text-muted-foreground">Nome verificado:</span>{" "}
                  {summary.verified_name}
                </p>
              )}
              {summary.display_phone_number && (
                <p>
                  <span className="text-muted-foreground">Número:</span>{" "}
                  {summary.display_phone_number}
                </p>
              )}
              {summary.phone_number_id && (
                <p>
                  <span className="text-muted-foreground">Phone Number ID:</span>{" "}
                  {summary.phone_number_id}
                </p>
              )}
              {summary.waba_id && (
                <p>
                  <span className="text-muted-foreground">WABA:</span> {summary.waba_id}
                </p>
              )}
              {summary.webhook_subscription_status && (
                <p>
                  <span className="text-muted-foreground">Webhook:</span>{" "}
                  {summary.webhook_subscription_status}
                </p>
              )}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            O celular continua com o WhatsApp Business App. O código temporário é enviado só ao
            servidor e o access token nunca fica no navegador. Echo/history sync avançados exigem
            fixtures oficiais da Meta antes de alterar direction.
          </p>

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="rounded-md px-3 py-2 text-sm hover:bg-accent"
              type="button"
            >
              {flowState === "conectado" ? "Fechar" : "Cancelar"}
            </button>
            {flowState !== "conectado" && (
              <button
                onClick={() => void connectExistingNumber()}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-50"
                type="button"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Conectar número existente em coexistência
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
