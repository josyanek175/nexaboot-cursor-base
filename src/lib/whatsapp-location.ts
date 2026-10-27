export type SharedLocation = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
export function parseSharedLocation(value: unknown): SharedLocation | null {
  const v = record(value);
  if (!v) return null;
  const latitude = v.latitude ?? v.degreesLatitude;
  const longitude = v.longitude ?? v.degreesLongitude;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  const text = (s: unknown) =>
    typeof s === "string" && s.trim() ? s.trim().slice(0, 500) : undefined;
  return { latitude, longitude, name: text(v.name), address: text(v.address) };
}
export function locationFromPayload(raw: unknown): SharedLocation | null {
  const p = record(raw);
  if (!p) return null;
  const m = record(p.message);
  const data = record(p.data);
  const dm = record(data?.message);
  return (
    parseSharedLocation(p.location) ??
    parseSharedLocation(m?.location) ??
    parseSharedLocation(m?.locationMessage) ??
    parseSharedLocation(dm?.locationMessage)
  );
}
export function locationMapUrl(location: SharedLocation): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.latitude},${location.longitude}`)}`;
}
export function locationMessageText(location: SharedLocation): string {
  return ["📍 Localização", location.name, location.address, locationMapUrl(location)]
    .filter(Boolean)
    .join("\n");
}
