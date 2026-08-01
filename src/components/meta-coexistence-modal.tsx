/**
 * Modal isolado — Meta Coexistence / Embedded Signup.
 * Fluxo: Embedded Signup → exchange(code+state) → connect(onboarding_id).
 * Não substitui MetaTokenModal (Cloud API tradicional).
 * Não guarda code/token em localStorage nem query string.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost } from "@/lib/api";

type CoexistenceConfig = {
  enabled: boolean;
  ready: boolean;
  migrationApplied: boolean;
  appId: string | null;
  configId: string | null;
  graphVersion: string;
  csrf_state?: string;
};

type OnboardingSafe = {
  onboarding_id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  business_id: string | null;
  expires_at: string;
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

    const existing = document.getElementById("facebook-jssdk");
    if (existing) return;

    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.onerror = () => reject(new Error("Falha ao carregar Facebook SDK"));
    document.body.appendChild(script);
  });
}

export function MetaCoexistenceModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<CoexistenceConfig | null>(null);
  const [name, setName] = useState("");
  const [onboarding, setOnboarding] = useState<OnboardingSafe | null>(null);
  const csrfRef = useRef<string | null>(null);
  const sessionInfoRef = useRef<SessionInfo>({});

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet("/meta/coexistence/config");
      setConfig(data as CoexistenceConfig);
      csrfRef.current = typeof data.csrf_state === "string" ? data.csrf_state : null;
      if (data.appId && data.graphVersion) {
        await loadFacebookSdk(String(data.appId), String(data.graphVersion));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Coexistence indisponível");
      onClose();
    } finally {
      setLoading(false);
    }
  }, [onClose]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

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

  async function startEmbeddedSignup() {
    if (!config?.appId || !config.configId) {
      toast.error("META_APP_ID / META_EMBEDDED_SIGNUP_CONFIG_ID não configurados");
      return;
    }
    if (!window.FB) {
      toast.error("Facebook SDK não carregou");
      return;
    }
    if (!csrfRef.current) {
      toast.error("CSRF state ausente — recarregue o modal");
      return;
    }

    setBusy(true);
    try {
      const code = await new Promise<string>((resolve, reject) => {
        window.FB!.login(
          (response) => {
            const authCode = response.authResponse?.code;
            if (!authCode) {
              reject(new Error("Embedded Signup cancelado ou sem code"));
              return;
            }
            resolve(authCode);
          },
          {
            config_id: config.configId,
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

      // Code sobe só para /exchange (memória da Promise). Não fica em state React.
      const exchange = await apiPost("/meta/coexistence/exchange", {
        code,
        state: csrfRef.current,
        session_info: Object.keys(sessionInfoRef.current).length
          ? sessionInfoRef.current
          : undefined,
      });

      const safe = exchange.onboarding as OnboardingSafe | undefined;
      if (!safe?.onboarding_id) {
        throw new Error("Onboarding não retornado pelo servidor");
      }
      setOnboarding(safe);
      csrfRef.current = null; // state consumido
      toast.success("Onboarding pronto. Confirme a conexão.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha no Embedded Signup");
      // Renova CSRF para nova tentativa
      try {
        const data = await apiGet("/meta/coexistence/config");
        csrfRef.current = typeof data.csrf_state === "string" ? data.csrf_state : null;
        setConfig(data as CoexistenceConfig);
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  async function finishConnect() {
    if (!onboarding?.onboarding_id) {
      toast.error("Execute o Embedded Signup antes de conectar");
      return;
    }
    if (!config?.migrationApplied) {
      toast.error("Migration meta_connection_mode ainda não aplicada em DEV");
      return;
    }

    setBusy(true);
    try {
      await apiPost("/meta/coexistence/connect", {
        onboarding_id: onboarding.onboarding_id,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setOnboarding(null);
      toast.success("Canal Meta Coexistence conectado");
      onConnected();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao conectar Coexistence");
      // onboarding_id já consumido no servidor — precisa novo Embedded Signup
      setOnboarding(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Meta Coexistence</h2>
            <p className="text-[11px] text-muted-foreground">
              Embedded Signup · code trocado uma vez no servidor
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          {loading ? (
            <div className="grid place-items-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <>
              {!config?.ready && (
                <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Ambiente incompleto: confira META_APP_ID, META_EMBEDDED_SIGNUP_CONFIG_ID e as
                  migrations Coexistence em DEV.
                </p>
              )}

              <label className="block text-xs font-medium">
                Nome do canal (opcional)
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  placeholder="Atendimento Coexistence"
                />
              </label>

              {onboarding && (
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs space-y-1">
                  <p>
                    <span className="text-muted-foreground">WABA:</span> {onboarding.waba_id}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Phone Number ID:</span>{" "}
                    {onboarding.phone_number_id}
                  </p>
                  {onboarding.display_phone_number && (
                    <p>
                      <span className="text-muted-foreground">Número:</span>{" "}
                      {onboarding.display_phone_number}
                    </p>
                  )}
                  <p className="text-muted-foreground">
                    Expira em {new Date(onboarding.expires_at).toLocaleString("pt-BR")}
                  </p>
                </div>
              )}

              <p className="text-[11px] text-muted-foreground">
                O authorization code é enviado apenas ao servidor e nunca reutilizado. Echo/history
                sync não são processados nesta entrega.
              </p>

              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <button
                  onClick={onClose}
                  className="rounded-md px-3 py-2 text-sm hover:bg-accent"
                  type="button"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => void startEmbeddedSignup()}
                  disabled={busy || !config?.appId || !!onboarding}
                  className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
                  type="button"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Embedded Signup
                </button>
                <button
                  onClick={() => void finishConnect()}
                  disabled={busy || !onboarding}
                  className="inline-flex items-center gap-2 rounded-md bg-whatsapp px-3 py-2 text-sm font-medium text-whatsapp-foreground hover:opacity-90 disabled:opacity-50"
                  type="button"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Conectar Coexistence
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
