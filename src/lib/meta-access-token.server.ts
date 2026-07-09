// Leitura server-only do access token Meta (whatsapp_channel_secrets + decrypt).

import { decryptToken, hasTokenEncryptionKey } from "@/lib/crypto/token-crypto.server";
import { sql, ensureCrmSchema } from "@/lib/pg.server";

export type MetaTokenMissingReason =
  | "missing_encryption_key"
  | "channel_not_found"
  | "secret_not_found"
  | "ciphertext_empty"
  | "decrypt_failed";

export type MetaTokenLoadResult =
  | { ok: true; token: string }
  | { ok: false; reason: MetaTokenMissingReason; errorMessage?: string };

export type MetaTokenLookupContext = {
  phoneNumberId?: string | null;
  source?: string;
};

function logTokenMissing(
  channelId: string,
  reason: MetaTokenMissingReason,
  extra?: Record<string, unknown>,
): void {
  console.error("[META_TOKEN_MISSING]", {
    channelId,
    reason,
    ...extra,
  });
}

/** Carrega e decripta token Meta com logs diagnósticos (nunca loga o token). */
export async function loadMetaAccessTokenDetailed(
  channelId: string,
  companyId: string,
  context: MetaTokenLookupContext = {},
): Promise<MetaTokenLoadResult> {
  const phoneNumberId = context.phoneNumberId?.trim() || null;
  const hasEncryptionKey = hasTokenEncryptionKey();

  console.log("[META_TOKEN_LOOKUP_START]", {
    channelId,
    companyId,
    phoneNumberId,
    hasEncryptionKey,
    source: context.source ?? "load",
  });

  if (!hasEncryptionKey) {
    logTokenMissing(channelId, "missing_encryption_key", {
      hint: "Configure META_TOKEN_ENCRYPTION_KEY no serviço nexaboot-web (não Evolution)",
    });
    return {
      ok: false,
      reason: "missing_encryption_key",
      errorMessage: "META_TOKEN_ENCRYPTION_KEY não configurada no nexaboot-web",
    };
  }

  await ensureCrmSchema();
  const s = sql();

  const rows = await s<
    {
      channel_id: string | null;
      ciphertext: string | null;
      token_status: string | null;
    }[]
  >`
    SELECT ch.id AS channel_id,
           sec.access_token_ciphertext AS ciphertext,
           ch.token_status
    FROM public.whatsapp_channels ch
    LEFT JOIN public.whatsapp_channel_secrets sec ON sec.channel_id = ch.id
    WHERE ch.id = ${channelId}::uuid
      AND ch.company_id = ${companyId}::uuid
      AND lower(ch.channel_type) = 'meta'
      AND ch.deleted_at IS NULL
    LIMIT 1
  `;

  const row = rows[0];
  if (!row?.channel_id) {
    logTokenMissing(channelId, "channel_not_found", { companyId });
    return { ok: false, reason: "channel_not_found", errorMessage: "Canal Meta não encontrado" };
  }

  const hasEncryptedToken = !!row.ciphertext?.trim();
  console.log("[META_TOKEN_SECRET_FOUND]", {
    channelId,
    hasEncryptedToken,
    tokenStatus: row.token_status,
  });

  if (!row.ciphertext) {
    logTokenMissing(channelId, "secret_not_found", {
      hint: "Nenhuma linha em whatsapp_channel_secrets para este canal",
    });
    return {
      ok: false,
      reason: "secret_not_found",
      errorMessage: "Token Meta não salvo em whatsapp_channel_secrets",
    };
  }

  if (!row.ciphertext.trim()) {
    logTokenMissing(channelId, "ciphertext_empty");
    return {
      ok: false,
      reason: "ciphertext_empty",
      errorMessage: "Registro de token existe, mas access_token_ciphertext está vazio",
    };
  }

  try {
    const token = decryptToken(row.ciphertext);
    console.log("[META_TOKEN_DECRYPT_OK]", { channelId });
    return { ok: true, token };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("[META_TOKEN_DECRYPT_FAILED]", { channelId, errorMessage });
    return {
      ok: false,
      reason: "decrypt_failed",
      errorMessage,
    };
  }
}

/** Compat: retorna token ou null (use loadMetaAccessTokenDetailed para diagnóstico). */
export async function loadMetaAccessToken(
  channelId: string,
  companyId: string,
  context?: MetaTokenLookupContext,
): Promise<string | null> {
  const result = await loadMetaAccessTokenDetailed(channelId, companyId, context);
  return result.ok ? result.token : null;
}

export function metaTokenUserMessage(reason: MetaTokenMissingReason): string {
  switch (reason) {
    case "missing_encryption_key":
      return "META_TOKEN_ENCRYPTION_KEY não está no serviço nexaboot-web. Configure no EasyPanel (não no container Evolution).";
    case "secret_not_found":
    case "ciphertext_empty":
      return "Token Meta não salvo para este canal. Clique em Conectar Meta e informe o access token do painel Meta.";
    case "decrypt_failed":
      return "Token Meta salvo, mas não foi possível decriptar. Verifique se META_TOKEN_ENCRYPTION_KEY é a mesma usada quando o token foi cadastrado e refaça a conexão do canal.";
    case "channel_not_found":
      return "Canal Meta não encontrado para esta empresa.";
    default:
      return "Token Meta indisponível.";
  }
}

export function metaTokenErrorCode(reason: MetaTokenMissingReason): string {
  switch (reason) {
    case "missing_encryption_key":
      return "missing_encryption_key";
    case "secret_not_found":
    case "ciphertext_empty":
      return "token_not_saved";
    case "decrypt_failed":
      return "decrypt_failed";
    case "channel_not_found":
      return "channel_not_found";
    default:
      return "missing_access_token";
  }
}
