// Utilidades de alerta: permissão, notificação do navegador e som discreto.
// Não depende de assets externos — usa WebAudio para gerar um "beep" curto.

let permissionRequested = false;

export async function ensureNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "default" && !permissionRequested) {
    permissionRequested = true;
    try {
      await Notification.requestPermission();
    } catch {
      /* navegador pode bloquear sem gesto do usuário — ignoramos */
    }
  }
  return Notification.permission;
}

export function showBrowserNotification(title: string, body: string, opts?: { tag?: string }) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: opts?.tag, silent: true });
  } catch {
    /* alguns browsers (iOS Safari) negam — apenas ignoramos */
  }
}

let audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx ||= new Ctor();
    return audioCtx;
  } catch {
    return null;
  }
}

export function playNotificationSound() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = "sine";
    o.frequency.setValueAtTime(880, now);
    o.frequency.exponentialRampToValueAtTime(660, now + 0.15);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.15, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    o.start(now);
    o.stop(now + 0.24);
  } catch {
    /* silencioso se o navegador bloquear autoplay */
  }
}

export function isTabHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}
