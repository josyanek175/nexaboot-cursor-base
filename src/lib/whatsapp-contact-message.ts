/**
 * Extrai contatos compartilhados do payload Evolution/WhatsApp
 * (contactMessage, contactsArrayMessage, vCard).
 */

export type SharedContact = {
  name?: string;
  phone?: string;
  vcard?: string;
};

function cleanPhone(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = String(raw).replace(/[^\d+]/g, "").trim();
  if (!digits) return undefined;
  // Preferir só dígitos para exibição consistente (mantém + se vier no início).
  const only = digits.startsWith("+") ? `+${digits.slice(1).replace(/\D/g, "")}` : digits.replace(/\D/g, "");
  return only || undefined;
}

/** Extrai FN: e TEL: (ou waid=) de um bloco BEGIN:VCARD … END:VCARD. */
export function parseVcard(vcard: string): SharedContact {
  const text = String(vcard || "");
  const nameMatch = text.match(/^FN:(.+)$/im);
  const name = nameMatch?.[1]?.trim().replace(/\\,/g, ",").replace(/\\;/g, ";") || undefined;

  const waidMatch =
    text.match(/TEL[^:\r\n]*;waid=(\d+)/i) ||
    text.match(/waid=(\d+)/i);
  let phone = cleanPhone(waidMatch?.[1]);
  if (!phone) {
    const telMatch = text.match(/^TEL(?:;[^:\r\n]*)?:(.+)$/im);
    phone = cleanPhone(telMatch?.[1]);
  }

  return { name, phone, vcard: text || undefined };
}

function fromContactEntry(entry: any): SharedContact {
  if (!entry || typeof entry !== "object") return {};
  const vcard = typeof entry.vcard === "string" ? entry.vcard : typeof entry.vCard === "string" ? entry.vCard : "";
  const parsed = vcard ? parseVcard(vcard) : {};
  const displayName =
    (typeof entry.displayName === "string" && entry.displayName.trim()) ||
    (typeof entry.name === "string" && entry.name.trim()) ||
    undefined;
  return {
    name: parsed.name || displayName,
    phone: parsed.phone,
    vcard: parsed.vcard || vcard || undefined,
  };
}

function extractFromContactMessage(cm: any): SharedContact[] {
  if (!cm) return [];
  const one = fromContactEntry(cm);
  if (one.name || one.phone || one.vcard) return [one];
  return [{ name: undefined, phone: undefined }];
}

function extractFromContactsArrayMessage(cam: any): SharedContact[] {
  if (!cam) return [];
  const list: any[] = Array.isArray(cam.contacts)
    ? cam.contacts
    : Array.isArray(cam.message?.contacts)
      ? cam.message.contacts
      : [];
  const out = list.map(fromContactEntry).filter((c) => c.name || c.phone || c.vcard);
  return out.length > 0 ? out : [{ name: undefined, phone: undefined }];
}

/** Localiza o objeto `message` dentro do payload Evolution (várias formas). */
export function getWhatsappMessageNode(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;
  if (r.message && typeof r.message === "object") return r.message as Record<string, unknown>;
  if (r.data?.message && typeof r.data.message === "object") return r.data.message as Record<string, unknown>;
  if (r.data?.data?.message && typeof r.data.data.message === "object") {
    return r.data.data.message as Record<string, unknown>;
  }
  // Alguns eventos trazem o envelope em data sem aninhar em message.
  if (r.data?.contactMessage || r.data?.contactsArrayMessage) {
    return r.data as Record<string, unknown>;
  }
  if (r.contactMessage || r.contactsArrayMessage) return r as Record<string, unknown>;
  return null;
}

/** Detecta se o nó message (ou payload) contém contato compartilhado. */
export function hasContactPayload(raw: unknown): boolean {
  const m = getWhatsappMessageNode(raw);
  if (!m) {
    const s = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
    return /BEGIN:VCARD/i.test(s) || /contactMessage|contactsArrayMessage/i.test(s);
  }
  if (m.contactMessage || m.contactsArrayMessage) return true;
  const s = JSON.stringify(m);
  return /BEGIN:VCARD/i.test(s);
}

/** Extrai lista de contatos de um payload bruto ou nó message. */
export function extractSharedContacts(raw: unknown): SharedContact[] {
  const m = getWhatsappMessageNode(raw) ?? (raw && typeof raw === "object" ? (raw as any) : null);
  if (!m) {
    if (typeof raw === "string" && /BEGIN:VCARD/i.test(raw)) {
      return [parseVcard(raw)];
    }
    return [];
  }

  if (m.contactMessage) return extractFromContactMessage(m.contactMessage);
  if (m.contactsArrayMessage) return extractFromContactsArrayMessage(m.contactsArrayMessage);

  // Fallback: vcard solto no JSON.
  const s = JSON.stringify(m);
  if (/BEGIN:VCARD/i.test(s)) {
    const blocks = s.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) ?? [];
    const parsed = blocks.map((b) => parseVcard(b.replace(/\\n/g, "\n").replace(/\\r/g, "")));
    if (parsed.length) return parsed;
  }
  return [];
}

export function isContactsArrayPayload(raw: unknown): boolean {
  const m = getWhatsappMessageNode(raw);
  return !!(m && m.contactsArrayMessage);
}

export function formatContactMessageText(contacts: SharedContact[], plural: boolean): string {
  if (contacts.length === 0) {
    return plural ? "Contatos compartilhados" : "Contato compartilhado";
  }
  if (!plural && contacts.length === 1) {
    const c = contacts[0];
    const name = c.name?.trim() || "Contato";
    const phone = c.phone?.trim();
    return phone ? `Contato compartilhado: ${name} - ${phone}` : `Contato compartilhado: ${name}`;
  }
  const parts = contacts.map((c) => {
    const name = c.name?.trim() || "Contato";
    const phone = c.phone?.trim();
    return phone ? `${name} - ${phone}` : name;
  });
  return `Contatos compartilhados: ${parts.join("; ")}`;
}

export type ContactParsedMsg = {
  type: "contact" | "contacts";
  body: string;
  contacts: SharedContact[];
};

/** Interpreta contactMessage / contactsArrayMessage no nó message da Evolution. */
export function parseContactMessageNode(msg: Record<string, unknown> | null | undefined): ContactParsedMsg | null {
  if (!msg) return null;
  const m = msg as any;
  if (m.contactMessage) {
    const contacts = extractFromContactMessage(m.contactMessage);
    return {
      type: "contact",
      body: formatContactMessageText(contacts, false),
      contacts,
    };
  }
  if (m.contactsArrayMessage) {
    const contacts = extractFromContactsArrayMessage(m.contactsArrayMessage);
    return {
      type: "contacts",
      body: formatContactMessageText(contacts, true),
      contacts,
    };
  }
  return null;
}
