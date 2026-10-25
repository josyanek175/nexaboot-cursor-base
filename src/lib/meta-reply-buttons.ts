export type ReplyButton = { id: string; label: string };

/** Meta reply buttons: https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/interactive/ */
export function metaTextPayload(body: string, buttons?: ReplyButton[]) {
  if (!buttons?.length) return { type: "text", text: { preview_url: false, body } };
  if (
    buttons.length > 3 ||
    body.length > 1024 ||
    !body.trim() ||
    buttons.some(
      (b) => !b.id.trim() || b.id.length > 256 || !b.label.trim() || b.label.length > 20,
    ) ||
    new Set(buttons.map((b) => b.id)).size !== buttons.length ||
    new Set(buttons.map((b) => b.label)).size !== buttons.length
  ) {
    throw new Error("invalid_meta_reply_buttons");
  }
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.label } })),
      },
    },
  };
}
