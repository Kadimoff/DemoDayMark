// munsif stage: the last-5-seconds takeover. The timer bubble flies to the centre and becomes a big ring,
// each second lands as a shrinking digit with sparks, rings and orbiting particles that multiply, the screen
// shakes, and at zero a "VAXT BİTDİ" burst. Canvas particles + CSS; a "lite" mode for weak projector laptops.
export interface FinaleOpts {
  root: HTMLElement;        // #finale
  bubble: HTMLElement;      // the floating timer bubble (flies to the centre)
  reduced: boolean;
  slow?: number;            // demo: time runs N× slower (for screenshots)
  sfx: Sfx;
}

// ---------- sound (WebAudio synth, shared master with a compressor) ----------
export class Sfx {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;
  constructor(private getCtx: () => AudioContext | null) {}
  private ok() {
    const c = this.getCtx();
    if (!c || c.state !== "running" || this.muted) return null;
    if (this.ctx !== c) {
      this.ctx = c;
      const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6;
      this.master = c.createGain(); this.master.gain.value = 0.85; this.master.connect(comp); comp.connect(c.destination);
      this.noiseBuf = null;
    }
    return c;
  }
  private env(g: GainNode, t: number, a: number, peak: number, d: number) {
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  private tone(type: OscillatorType, f0: number, f1: number, t: number, a: number, peak: number, d: number, dest?: AudioNode) {
    const c = this.ctx!; const o = c.createOscillator(), g = c.createGain(); o.type = type;
    o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + a + d);
    this.env(g, t, a, peak, d); o.connect(g); g.connect(dest ?? this.master!); o.start(t); o.stop(t + a + d + 0.05);
  }
  private noise(t: number, dur: number, f0: number, f1: number, peak: number, type: BiquadFilterType = "lowpass", q = 0.8) {
    const c = this.ctx!;
    if (!this.noiseBuf) { this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate); const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const s = c.createBufferSource(); s.buffer = this.noiseBuf; const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain(); this.env(g, t, 0.01, peak, dur); s.connect(f); f.connect(g); g.connect(this.master!); s.start(t); s.stop(t + dur + 0.05);
  }
  soft() { const c = this.ok(); if (!c) return; this.tone("sine", 1250, 1250, c.currentTime, 0.003, 0.08, 0.08); }
  tick(n: number) {
    const c = this.ok(); if (!c) return; const t = c.currentTime; const k = 5 - n;
    this.tone("triangle", 620 + k * 120, 620 + k * 120, t, 0.004, 0.42, 0.28);
    this.tone("sine", 1240 + k * 240, 1240 + k * 240, t, 0.002, 0.12, 0.12);
    this.tone("sine", 160, 42, t, 0.005, 0.95, 0.38);
    this.noise(t, 0.12, 6000, 1500, 0.10 + k * 0.03, "highpass");
    if (n <= 2) this.tone("sawtooth", 110 + k * 20, 90, t, 0.01, 0.10, 0.5);
  }
  boom() {
    const c = this.ok(); if (!c) return; const t = c.currentTime;
    this.tone("sine", 95, 28, t, 0.005, 1.0, 1.5);
    this.noise(t, 1.6, 4200, 120, 0.7);
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(2600, t); lp.frequency.exponentialRampToValueAtTime(500, t + 2.2); lp.connect(this.master!);
    for (const f of [220, 277.18, 329.63, 440]) this.tone("sawtooth", f, f, t + 0.02, 0.02, 0.09, 2.2, lp);
    this.tone("square", 880, 880, t + 0.02, 0.01, 0.05, 0.9, lp);
  }
  whoosh() { const c = this.ok(); if (!c) return; const t = c.currentTime; this.noise(t, 0.9, 300, 3200, 0.35, "bandpass", 1.4); this.tone("sine", 60, 120, t, 0.3, 0.3, 0.6); }
  go() { const c = this.ok(); if (!c) return; const t = c.currentTime; for (const f of [523.25, 659.25, 783.99]) this.tone("triangle", f, f, t, 0.01, 0.16, 0.7); }
}

type P =
  | { t: 0; x: number; y: number; vx: number; vy: number; life: number; age: number; s: number; c: string }
  | { t: 1; r: number; vr: number; life: number; age: number; w: number; c: string }
  | { t: 2; a: number; rad: number; w: number; s: number; age: number; life: number; tw: number; c: string }
  | { t: 3; x: number; y: number; vx: number; vy: number; rot: number; vr: number; w: number; h: number; age: number; life: number; c: string };

const BEAT_COLORS: Record<number, string> = { 5: "#FFB020", 4: "#FF9A2A", 3: "#FF7A3D", 2: "#FF5E52", 1: "#FF3D6A" };
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Finale {
  active = false;
  tu = false;
  n: number | null = null;
  lite: boolean;
  private P: P[] = [];
  private energy = 0;
  private shake = 0;
  private shakeAt = 0;
  private tuAt = 0;
  private exitAt = 0;
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private W = 0; private H = 0;
  private limitFull: number;
  private limit: number;
  private lowFrames = 0;
  private tinted = new Map<string, HTMLCanvasElement>();
  private sprite: HTMLCanvasElement;
  private els: { center: HTMLElement; nums: HTMLElement; bar: SVGCircleElement; glow: HTMLElement; vig: HTMLElement; tu: HTMLElement; tuTitle: HTMLElement; tuSub: HTMLElement; flash: HTMLElement };
  private slow: number;

  constructor(private o: FinaleOpts, forcedFx: "lite" | "full" | null) {
    const q = <T extends Element = HTMLElement>(s: string) => o.root.querySelector<T>(s)!;
    this.cv = q<HTMLCanvasElement>("canvas");
    this.ctx = this.cv.getContext("2d")!;
    this.els = { center: q(".st-fx-center"), nums: q(".st-fx-nums"), bar: q<SVGCircleElement>(".st-fx-ring .bar"), glow: q(".st-fx-glow"), vig: q(".st-fx-vig"),
      tu: q(".st-tu"), tuTitle: q(".st-tu-title"), tuSub: q(".st-tu-sub"), flash: q(".st-flash") };
    this.slow = o.slow ?? 1;
    let stored = false;
    try { stored = localStorage.getItem("munsif-fx-lite") === "1"; } catch { /* private mode */ }
    this.lite = o.reduced || forcedFx === "lite" || (forcedFx !== "full" && stored);
    document.body.classList.toggle("fx-lite", this.lite);
    this.limitFull = o.reduced ? 160 : 700;
    this.limit = this.lite ? Math.round(this.limitFull * 0.45) : this.limitFull;
    this.forcedFull = forcedFx === "full";
    this.sprite = (() => {
      const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d")!;
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.2, "rgba(255,255,255,.85)"); gr.addColorStop(0.45, "rgba(255,255,255,.25)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return c;
    })();
    this.size();
    addEventListener("resize", () => this.size());
  }
  private forcedFull: boolean;
  get particles() { return this.P.length; }

  private size() { this.W = innerWidth; this.H = innerHeight; this.cv.width = this.W; this.cv.height = this.H; }
  private tint(color: string) {
    let c = this.tinted.get(color);
    if (c) return c;
    c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d")!;
    g.drawImage(this.sprite, 0, 0); g.globalCompositeOperation = "source-in"; g.fillStyle = color; g.fillRect(0, 0, 64, 64);
    g.globalCompositeOperation = "lighter"; g.globalAlpha = 0.6; g.drawImage(this.sprite, 16, 16, 32, 32);
    this.tinted.set(color, c);
    return c;
  }
  private ringR() { const m = Math.min(innerWidth, innerHeight); return m * 0.62 > 640 ? 320 : m * 0.31; }
  private sparks(count: number, color: string, k = 1) {
    const R = this.ringR(), cx = this.W / 2, cy = this.H / 2;
    for (let i = 0; i < count && this.P.length < this.limit; i++) {
      const a = Math.random() * Math.PI * 2, sp = rnd(180, 820) * k, rr = R * rnd(0.92, 1.06);
      this.P.push({ t: 0, x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(0.55, 1.25), age: 0, s: rnd(5, 14), c: Math.random() < 0.25 ? "#ffffff" : color });
    }
  }
  private rings(count: number, color: string, step = 0.09, big = 1) {
    const R = this.ringR();
    for (let i = 0; i < count; i++) this.P.push({ t: 1, r: R * rnd(0.96, 1.02), vr: R * rnd(0.9, 1.5) * big, life: 1.1, age: -i * step, w: rnd(3, 7) * big, c: i % 2 ? "#ffffff" : color });
  }
  private orbiters(target: number, color: string) {
    const cur = this.P.filter(p => p.t === 2).length, R = this.ringR();
    for (let i = cur; i < target && this.P.length < this.limit; i++) this.P.push({ t: 2, a: Math.random() * Math.PI * 2, rad: R * rnd(1.04, 1.42), w: rnd(0.5, 1.7) * (Math.random() < 0.5 ? -1 : 1), s: rnd(5, 12), age: 0, life: Infinity, tw: Math.random() * 6, c: Math.random() < 0.3 ? "#ffffff" : color });
  }
  private confetti(count: number) {
    const cols = ["#7C5CFF", "#9D86FF", "#D46BC4", "#FFB020", "#F5F5FA", "#FF4D6A", "#2EE59D"];
    for (let i = 0; i < count && this.P.length < this.limit + 300; i++) {
      const a = rnd(-Math.PI, 0) + rnd(-0.3, 0.3), sp = rnd(500, 1500);
      this.P.push({ t: 3, x: this.W / 2 + rnd(-40, 40), y: this.H / 2 + rnd(-30, 30), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 200, rot: Math.random() * 6, vr: rnd(-12, 12), w: rnd(8, 16), h: rnd(4, 9), age: 0, life: rnd(2.2, 3.6), c: cols[i % cols.length] });
    }
  }

  enter() {
    this.active = true; this.tu = false; this.n = null; this.P = []; this.energy = 0; this.shake = 0; this.exitAt = 0;
    const { root, bubble } = this.o;
    this.els.nums.innerHTML = ""; this.els.tu.hidden = true; this.els.center.style.cssText = "";
    root.classList.remove("on", "out"); root.hidden = false;
    const r = bubble.getBoundingClientRect();
    if (r.width) {
      const S2 = Math.min(Math.min(innerWidth, innerHeight) * 0.62, 640);
      bubble.style.transform = `translate(${innerWidth / 2 - (r.left + r.width / 2)}px, ${innerHeight / 2 - (r.top + r.height / 2)}px) scale(${S2 / r.width})`;
      bubble.classList.add("fly");
    }
    void root.offsetWidth; root.classList.add("on");
  }

  beat(n: number) {
    this.n = n;
    const k = 5 - n, color = BEAT_COLORS[n] ?? "#FF4D6A";
    const el = document.createElement("div");
    el.className = "st-fx-num"; el.textContent = String(n); el.style.setProperty("--g", color);
    if (this.slow > 1) el.style.animationDuration = `${this.slow}s`;
    this.els.nums.append(el);
    setTimeout(() => el.remove(), 1050 * this.slow);
    const mul = this.o.reduced ? 0.25 : this.lite ? 0.45 : 1;
    this.sparks(Math.round((26 + k * k * 14 + k * 20) * mul), color, 1 + k * 0.22);
    this.rings(this.o.reduced ? 1 : 1 + k, color, 0.08, 1 + k * 0.08);
    this.orbiters(Math.round([0, 130, 90, 56, 30, 14][n] * mul), color);
    this.energy = 0.3 + k * 0.32; this.shake = 3 + k * k * 1.6 + k * 2; this.shakeAt = performance.now();
    const v = this.els.vig; v.style.transition = "none"; v.style.opacity = String(0.25 + k * 0.17); void v.offsetWidth;
    v.style.transition = "opacity .9s ease"; v.style.opacity = String(0.08 + k * 0.08);
    this.o.sfx.tick(n);
  }
  setBar(frac: number) { this.els.bar.style.strokeDashoffset = String(565.49 * (1 - Math.max(0, Math.min(1, frac)))); }

  /** Zero: the burst. `title`/`sub` are the big words; the overlay leaves after `holdMs`. */
  timesUp(title: string, sub: string, holdMs: number) {
    if (!this.active) this.enter();
    this.tu = true; this.tuAt = performance.now(); this.n = 0; this.energy = 1.4;
    this.shake = this.o.reduced ? 0 : 26; this.shakeAt = performance.now();
    this.els.nums.innerHTML = "";
    const c = this.els.center; c.style.transition = "opacity .35s ease, transform .5s ease"; c.style.opacity = "0"; c.style.transform = "scale(1.7)";
    const fl = this.els.flash; fl.classList.remove("go"); void fl.offsetWidth; fl.classList.add("go");
    this.els.tuTitle.textContent = title; this.els.tuSub.textContent = sub; this.els.tu.hidden = false;
    this.sparks(this.o.reduced ? 60 : this.lite ? 140 : 320, "#FFB020", 1.9);
    this.rings(this.o.reduced ? 1 : 4, "#ffffff", 0.12, 2.2);
    if (!this.o.reduced) this.confetti(this.lite ? 120 : 240);
    const v = this.els.vig; v.style.transition = "opacity 2s ease"; v.style.opacity = "0";
    this.o.sfx.boom();
    this.exitAt = performance.now() + holdMs * this.slow;
  }

  exit() {
    if (!this.active) return;
    this.active = false; this.tu = false; this.n = null;
    const { root, bubble } = this.o;
    root.classList.add("out");
    bubble.style.transform = ""; bubble.classList.remove("fly");
    setTimeout(() => { if (!this.active) { root.hidden = true; root.classList.remove("on", "out"); this.P = []; this.els.nums.innerHTML = ""; } }, 820);
  }

  get shouldLeave() { return this.active && this.tu && performance.now() > this.exitAt; }

  /** Per animation frame (dt in seconds of real time). */
  step(dtReal: number) {
    if (this.o.root.hidden) return;
    const dt = dtReal / this.slow;
    this.energy *= Math.pow(0.6, dt);
    const { ctx } = this; const cx = this.W / 2, cy = this.H / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.W, this.H);
    this.els.glow.style.opacity = String(Math.min(1, this.energy * 0.55));
    const keep: P[] = [];
    for (const p of this.P) {
      p.age += dt;
      if (p.age > p.life) continue;
      if (p.t === 0) {
        const dr = Math.pow(0.08, dt); p.vx *= dr; p.vy *= dr; p.vy += 60 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        const k = 1 - p.age / p.life; ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = k; const s = p.s * (0.6 + k * 0.6);
        ctx.drawImage(this.tint(p.c), p.x - s, p.y - s, s * 2, s * 2);
      } else if (p.t === 1) {
        if (p.age < 0) { keep.push(p); continue; }
        const k = 1 - p.age / p.life; const r = p.r + p.vr * p.age * (1.2 - p.age * 0.35);
        ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = k * 0.9; ctx.strokeStyle = p.c; ctx.lineWidth = p.w * k + 0.5;
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2); ctx.stroke();
      } else if (p.t === 2) {
        p.a += p.w * dt * (1 + this.energy * 0.6); p.tw += dt * 8;
        const x = cx + Math.cos(p.a) * p.rad, y = cy + Math.sin(p.a) * p.rad; const k = 0.55 + 0.45 * Math.sin(p.tw);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = this.tu ? Math.max(0, 1 - (performance.now() - this.tuAt) / 600 / this.slow) : k;
        ctx.drawImage(this.tint(p.c), x - p.s, y - p.s, p.s * 2, p.s * 2);
        if (this.tu) p.rad += 900 * dt;
      } else {
        p.vx *= Math.pow(0.35, dt); p.vy = p.vy * Math.pow(0.35, dt) + 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = Math.min(1, (p.life - p.age) * 1.5);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(p.rot * 2)); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      }
      keep.push(p);
    }
    this.P = keep; ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    if (!this.o.reduced && this.shake > 0) {
      const e = (performance.now() - this.shakeAt) / 1000 / this.slow; const amp = this.shake * Math.max(0, 1 - e / 0.45);
      const x = (Math.random() * 2 - 1) * amp, y = (Math.random() * 2 - 1) * amp;
      this.els.center.style.translate = `${x}px ${y}px`; this.cv.style.translate = `${x * 0.5}px ${y * 0.5}px`;
      if (amp <= 0) { this.shake = 0; this.els.center.style.translate = ""; this.cv.style.translate = ""; }
    }
    // Weak GPU/CPU: drop the live backdrop blur and halve the particles (remembered on this machine).
    if (!this.lite && !this.forcedFull) {
      this.lowFrames = dtReal > 1 / 30 ? this.lowFrames + dtReal : Math.max(0, this.lowFrames - dtReal * 0.5);
      if (this.lowFrames > 0.6) {
        this.lite = true; this.limit = Math.round(this.limitFull * 0.45); document.body.classList.add("fx-lite");
        try { localStorage.setItem("munsif-fx-lite", "1"); } catch { /* private mode */ }
      }
    }
  }
}

/** The markup the finale expects inside #finale. */
export const FINALE_HTML = `
  <div class="st-fx-back"></div><div class="st-fx-glow"></div><div class="st-fx-vig"></div><canvas class="st-fx-canvas"></canvas>
  <div class="st-fx-center">
    <svg viewBox="0 0 200 200" class="st-fx-ring" aria-hidden="true"><defs><linearGradient id="fxg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFB020"/><stop offset="1" stop-color="#FF4D6A"/></linearGradient></defs>
      <circle cx="100" cy="100" r="90" class="track"/><circle cx="100" cy="100" r="90" class="bar"/></svg>
    <div class="st-fx-nums"></div>
  </div>
  <div class="st-tu" hidden><div class="st-rays"></div><div class="st-tu-in"><div class="st-tu-title">VAXT BİTDİ</div><div class="st-tu-sub"></div></div></div>
  <div class="st-flash"></div>`;
