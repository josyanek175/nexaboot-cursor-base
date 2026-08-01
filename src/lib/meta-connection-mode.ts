/** Modos de conexão Meta — aditivo; default cloud_api preserva canais existentes. */
export const META_CONNECTION_MODES = ["cloud_api", "coexistence"] as const;

export type MetaConnectionMode = (typeof META_CONNECTION_MODES)[number];

export const DEFAULT_META_CONNECTION_MODE: MetaConnectionMode = "cloud_api";

export function isMetaConnectionMode(value: unknown): value is MetaConnectionMode {
  return (
    typeof value === "string" &&
    (META_CONNECTION_MODES as readonly string[]).includes(value)
  );
}

/** Normaliza valor vindo do DB/API; ausente/ inválido → cloud_api. */
export function resolveMetaConnectionMode(value: unknown): MetaConnectionMode {
  if (isMetaConnectionMode(value)) return value;
  return DEFAULT_META_CONNECTION_MODE;
}
