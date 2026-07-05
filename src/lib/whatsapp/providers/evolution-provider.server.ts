// Wrapper fino sobre evolution.server.ts — não altera rotas/fluxo Evolution existente.
// Consulta status ao vivo; não persiste no banco (isso continua nas rotas /api/evolution/channels/*).

import { hasEvoConfig, instanceState, mapEvoStatus } from "@/lib/evolution.server";
import type {
  ProviderSendResult,
  ProviderStatusResult,
  WhatsAppChannelRecord,
  WhatsAppProvider,
} from "@/lib/whatsapp/providers/whatsapp-provider.types";

export class EvolutionProvider implements WhatsAppProvider {
  readonly kind = "evolution" as const;

  async getStatus(channel: WhatsAppChannelRecord): Promise<ProviderStatusResult> {
    const instance = channel.evolutionInstanceName?.trim();
    if (!instance) {
      return {
        ok: false,
        provider: this.kind,
        status: channel.status,
        configured: hasEvoConfig(),
        error: "missing_instance_name",
      };
    }

    if (!hasEvoConfig()) {
      return {
        ok: false,
        provider: this.kind,
        status: channel.status,
        configured: false,
        error: "missing_config",
      };
    }

    const st = await instanceState(instance);
    if (!st.ok) {
      return {
        ok: false,
        provider: this.kind,
        status: channel.status,
        configured: true,
        error: st.error ?? "evolution_status_failed",
      };
    }

    const rawState = st.data?.instance?.state ?? st.data?.state;
    const mapped = mapEvoStatus(rawState);

    return {
      ok: true,
      provider: this.kind,
      status: mapped,
      configured: true,
    };
  }

  async sendText(
    _channel: WhatsAppChannelRecord,
    _to: string,
    _body: string,
  ): Promise<ProviderSendResult> {
    return { ok: false, notImplemented: true, error: "not_implemented" };
  }
}

export const evolutionProvider = new EvolutionProvider();
