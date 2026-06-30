// Som discreto para novas notificações da Comunicação Interna.
// Arquivo: /sounds/notification.wav
// Falha em silêncio se o navegador bloquear autoplay.

const STORAGE_KEY = "nexaboot:notification-sounds-enabled";
const SOUND_URL = "/sounds/notification.wav";

let audioContext: AudioContext | null = null;
let htmlAudio: HTMLAudioElement | null = null;
let decodedBuffer: AudioBuffer | null = null;
let decodePromise: Promise<AudioBuffer | null> | null = null;

/** Baseline do contador interno — primeira atualização não toca som. */
let internalUnreadBaseline: number | null = null;

const preferenceListeners = new Set<(enabled: boolean) => void>();

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function getNotificationSoundsEnabled(): boolean {
  if (!isBrowser()) return true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    return raw === "1" || raw === "true";
  } catch {
    return true;
  }
}

export function setNotificationSoundsEnabled(enabled: boolean): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* quota / modo privado */
  }
  preferenceListeners.forEach((l) => l(enabled));
}

export function subscribeNotificationSoundsEnabled(
  listener: (enabled: boolean) => void,
): () => void {
  preferenceListeners.add(listener);
  listener(getNotificationSoundsEnabled());
  return () => preferenceListeners.delete(listener);
}

function getAudioContext(): AudioContext | null {
  if (!isBrowser()) return null;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!audioContext) audioContext = new Ctx();
  return audioContext;
}

function getHtmlAudio(): HTMLAudioElement | null {
  if (!isBrowser()) return null;
  if (!htmlAudio) {
    htmlAudio = new Audio(SOUND_URL);
    htmlAudio.preload = "auto";
    htmlAudio.loop = false;
  }
  return htmlAudio;
}

async function loadDecodedBuffer(): Promise<AudioBuffer | null> {
  if (decodedBuffer) return decodedBuffer;
  if (decodePromise) return decodePromise;

  decodePromise = (async () => {
    const ctx = getAudioContext();
    if (!ctx) return null;
    try {
      const res = await fetch(SOUND_URL);
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      decodedBuffer = await ctx.decodeAudioData(data.slice(0));
      return decodedBuffer;
    } catch {
      return null;
    }
  })();

  return decodePromise;
}

/** Chamar após gesto do usuário para destravar autoplay (best-effort). */
export async function unlockNotificationAudio(): Promise<void> {
  if (!getNotificationSoundsEnabled()) return;
  const ctx = getAudioContext();
  if (ctx?.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }
  const el = getHtmlAudio();
  if (!el) return;
  try {
    el.muted = true;
    el.loop = false;
    el.currentTime = 0;
    await el.play();
    el.pause();
    el.currentTime = 0;
    el.muted = false;
  } catch {
    /* bloqueado — ok */
  }
}

async function playViaWebAudio(): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }
  const buffer = await loadDecodedBuffer();
  if (!buffer) return;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = false;

  const gain = ctx.createGain();
  gain.gain.value = 0.35;

  source.connect(gain);
  gain.connect(ctx.destination);
  source.start();
}

/**
 * Toca o som de notificação interna (curto, sem loop).
 * Respeita a preferência do usuário e falha em silêncio se bloqueado.
 */
export async function playNotificationSound(): Promise<void> {
  if (!isBrowser() || !getNotificationSoundsEnabled()) return;

  const el = getHtmlAudio();
  if (el) {
    try {
      el.loop = false;
      el.volume = 0.35;
      el.currentTime = 0;
      await el.play();
      return;
    } catch {
      /* fallback Web Audio */
    }
  }

  try {
    await playViaWebAudio();
  } catch {
    /* bloqueado — falha silenciosa */
  }
}

/**
 * Atualiza o contador interno e toca som apenas quando o total AUMENTA
 * após a primeira leitura (não toca notificações antigas no carregamento).
 */
export function onInternalUnreadCountUpdate(count: number): void {
  const next = Math.max(0, Math.floor(count));
  if (internalUnreadBaseline === null) {
    internalUnreadBaseline = next;
    return;
  }
  if (next > internalUnreadBaseline) {
    void playNotificationSound();
  }
  internalUnreadBaseline = next;
}

/** Reinicia baseline (ex.: logout). */
export function resetInternalUnreadBaseline(): void {
  internalUnreadBaseline = null;
}
