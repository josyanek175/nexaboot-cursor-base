export type ReplyButton = { id: string; title: string };

/** Shared provider/persistence payload. Never silently turn a Meta menu into plain text. */
export function metaMessageContent(body: string, buttons?: ReplyButton[]) {
  if (!buttons) return { type: "text" as const, text: { preview_url: false, body } };
  if (!body.trim() || body.length > 1024 || buttons.length < 1 || buttons.length > 3)
    throw new Error("invalid_interactive_buttons");
  const ids = new Set<string>();
  for (const button of buttons) {
    if (
      !button.id.trim() ||
      button.id.length > 256 ||
      ids.has(button.id) ||
      !button.title.trim() ||
      Array.from(button.title).length > 20
    )
      throw new Error("invalid_interactive_buttons");
    ids.add(button.id);
  }
  return {
    type: "interactive" as const,
    interactive: {
      type: "button" as const,
      body: { text: body },
      action: {
        buttons: buttons.map(({ id, title }) => ({ type: "reply" as const, reply: { id, title } })),
      },
    },
  };
}
