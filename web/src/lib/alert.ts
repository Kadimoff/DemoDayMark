// Getting a juror's attention for the coordinator's reminder: system notification where the browser allows it
// (HTTPS only), otherwise sound + vibration + a blinking tab title. The in-page modal is drawn by juror.ts.

let audio: AudioContext | null = null;
// Browsers allow sound only after a user gesture: unlock on the juror's first tap.
["pointerdown", "keydown"].forEach(ev => addEventListener(ev, () => {
  try { audio ??= new AudioContext(); if (audio.state === "suspended") void audio.resume(); } catch { /* no audio */ }
}, { once: true, capture: true }));

export function chime() {
  try {
    if (!audio || audio.state !== "running") return;
    const t0 = audio.currentTime;
    [[880, 0], [1174.66, .16], [1567.98, .32]].forEach(([f, at]) => {
      const o = audio!.createOscillator(), g = audio!.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.5);
      o.connect(g).connect(audio!.destination);
      o.start(t0 + at); o.stop(t0 + at + 0.55);
    });
  } catch { /* audio unavailable */ }
}

let blinkT = 0;
export function blinkTitle(text: string) {
  clearInterval(blinkT);
  const base = document.title;
  let on = false;
  blinkT = window.setInterval(() => { on = !on; document.title = on ? `🔔 ${text}` : base; }, 900);
  const stop = () => { clearInterval(blinkT); document.title = base; removeEventListener("focus", stop); document.removeEventListener("pointerdown", stop); };
  addEventListener("focus", stop);
  document.addEventListener("pointerdown", stop);
}

/** System notifications need a secure context (HTTPS) and a service worker on phones. */
export const canNotify = () => window.isSecureContext && "Notification" in window && "serviceWorker" in navigator;
export const notifyPermission = () => (canNotify() ? Notification.permission : "unsupported");

let reg: ServiceWorkerRegistration | null = null;
export async function enableNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (!canNotify()) return "unsupported";
  try {
    reg ??= await navigator.serviceWorker.register("/sw.js");
    const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    return p;
  } catch { return "denied"; }
}
if (canNotify() && Notification.permission === "granted") navigator.serviceWorker.register("/sw.js").then(r => { reg = r; }).catch(() => {});

export async function systemNotify(title: string, body: string) {
  if (!canNotify() || Notification.permission !== "granted") return false;
  try {
    reg ??= await navigator.serviceWorker.register("/sw.js");
    await reg.showNotification(title, { body, tag: "nudge", renotify: true, requireInteraction: true, icon: "/favicon.svg", vibrate: [220, 120, 220] } as NotificationOptions);
    return true;
  } catch { return false; }
}
