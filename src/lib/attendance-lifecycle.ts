/** Pure rules shared by inbound persistence and flow personalization. */
export function validProfileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 200);
  return name || null;
}
export function attendanceDisplayName(contact?: {
  name: string | null;
  name_source: string | null;
  whatsapp_profile_name: string | null;
  phone: string | null;
}): string {
  if (!contact) return "";
  const registered = validProfileName(contact.name);
  if (
    registered &&
    registered !== contact.phone &&
    (contact.name_source === "manual" || contact.name_source == null)
  )
    return registered;
  return (
    validProfileName(contact.whatsapp_profile_name) ??
    (contact.name_source === "whatsapp" && registered !== contact.phone ? (registered ?? "") : "")
  );
}
