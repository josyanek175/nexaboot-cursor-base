// GET /api/evolution/status — testa credenciais e instância da Evolution.
// Não grava nada. Lê EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE_NAME.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/evolution/status")({
  server: {
    handlers: {
      GET: async () => {
        const apiUrl = process.env.EVOLUTION_API_URL;
        const apiKey = process.env.EVOLUTION_API_KEY;
        const instanceName = process.env.EVOLUTION_INSTANCE_NAME || null;
        const base = { hasApiUrl: !!apiUrl, hasApiKey: !!apiKey, instanceName };
        console.log("[EVOLUTION_STATUS]", base);

        if (!apiUrl || !apiKey) {
          return Response.json({ ...base, connected: false, error: "missing_config" });
        }

        const url = `${apiUrl.replace(/\/+$/, "")}/instance/fetchInstances`;
        try {
          const res = await fetch(url, {
            headers: { apikey: apiKey, "Content-Type": "application/json" },
          });
          const text = await res.text().catch(() => "");
          if (!res.ok) {
            console.error("[EVOLUTION_ERROR]", { status: res.status, body: text.slice(0, 500) });
            return Response.json({
              ...base,
              connected: false,
              status: res.status,
              error: res.status === 401 || res.status === 403 ? "unauthorized_check_api_key" : "evolution_http_error",
              body: text.slice(0, 500),
            });
          }
          let data: any = null;
          try { data = JSON.parse(text); } catch { /* ignore */ }
          const instances = (Array.isArray(data) ? data : []).map((d: any) => ({
            instanceName: d.instance?.instanceName ?? d.instanceName ?? d.name,
            status: d.instance?.status ?? d.connectionStatus ?? d.status ?? null,
          }));
          const main = instanceName ? instances.find((i) => i.instanceName === instanceName) ?? null : null;
          return Response.json({
            ...base,
            connected: true,
            instanceFound: !!main,
            instanceStatus: main?.status ?? null,
            instances,
          });
        } catch (e) {
          console.error("[EVOLUTION_ERROR]", e);
          return Response.json({
            ...base,
            connected: false,
            error: "evolution_unreachable",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
  },
});
