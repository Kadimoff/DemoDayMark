// Small canvas particle engine for the winner scene: rising embers, firework rockets and
// bursts (additive glow), and 3D-flipping confetti ribbons.

type Kind = "ember" | "spark" | "rocket" | "confetti";
interface P {
  kind: Kind;
  x: number; y: number; vx: number; vy: number;
  px: number; py: number;
  life: number; max: number;
  size: number; color: string;
  rot: number; vr: number; sway: number;
  targetY?: number;
}

const MAX_PARTS = 1600;

export class FX {
  private g: CanvasRenderingContext2D;
  private parts: P[] = [];
  private raf = 0;
  private last = 0;
  private dpr = Math.min(1.5, devicePixelRatio || 1);
  private emberRate = 0;
  private emberAcc = 0;
  private emberColors: string[] = [];
  /** Called when a rocket explodes (x/y in CSS px) — used for the crackle sound. */
  onBurst?: (x: number, y: number) => void;
  fade = 1;
  /** "r,g,b" of the white-hot core sparks start with (set from a CSS token). */
  hot = "243,244,248";

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext("2d")!;
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  get w() { return this.canvas.width; }
  get h() { return this.canvas.height; }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round((r.width || innerWidth) * this.dpr));
    this.canvas.height = Math.max(1, Math.round((r.height || innerHeight) * this.dpr));
  }

  private add(p: Omit<P, "px" | "py">) {
    if (this.parts.length >= MAX_PARTS) return;
    this.parts.push({ ...p, px: p.x, py: p.y });
    this.start();
  }

  /** Continuous embers rising from the bottom edge; rate = particles per second (0 stops). */
  embers(rate: number, colors: string[]) {
    this.emberRate = rate;
    this.emberColors = colors;
    if (rate) this.start();
  }

  burst(xFrac: number, yFrac: number, colors: string[], count = 140, power = 1) {
    const d = this.dpr, x = xFrac * this.w, y = yFrac * this.h;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (Math.random() ** 0.5) * 9 * power * d;
      this.add({
        kind: "spark", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: 1.1 + Math.random() * 0.9, size: (1.2 + Math.random() * 1.8) * d,
        color: colors[(Math.random() * colors.length) | 0], rot: 0, vr: 0, sway: 0,
      });
    }
  }

  rocket(xFrac: number, colors: string[]) {
    const d = this.dpr;
    this.add({
      kind: "rocket", x: xFrac * this.w, y: this.h + 10 * d, vx: (Math.random() - 0.5) * 1.2 * d, vy: -(13 + Math.random() * 4) * d,
      life: 0, max: 4, size: 2.4 * d, color: colors[(Math.random() * colors.length) | 0], rot: 0, vr: 0, sway: 0,
      targetY: this.h * (0.16 + Math.random() * 0.3),
    });
    this.rocketColors = colors;
  }
  private rocketColors: string[] = [];

  confetti(count: number, colors: string[]) {
    const d = this.dpr;
    for (let i = 0; i < count; i++) {
      this.add({
        kind: "confetti", x: Math.random() * this.w, y: -Math.random() * this.h * 0.6, vx: (Math.random() - 0.5) * 2 * d, vy: (1.5 + Math.random() * 2.5) * d,
        life: 0, max: 9, size: (7 + Math.random() * 7) * d, color: colors[(Math.random() * colors.length) | 0],
        rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.25, sway: Math.random() * Math.PI * 2,
      });
    }
  }

  clear() {
    this.parts = [];
    this.emberRate = 0;
    this.fade = 1;
    this.g.clearRect(0, 0, this.w, this.h);
  }

  private start() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  private frame(t: number) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const k = dt * 60; // physics tuned at 60 fps
    const g = this.g, d = this.dpr;

    if (this.emberRate) {
      this.emberAcc += this.emberRate * dt;
      while (this.emberAcc >= 1) {
        this.emberAcc--;
        this.add({
          kind: "ember", x: Math.random() * this.w, y: this.h + 6 * d, vx: 0, vy: -(0.8 + Math.random() * 1.8) * d,
          life: 0, max: 3.5 + Math.random() * 3, size: (1 + Math.random() * 2.2) * d,
          color: this.emberColors[(Math.random() * this.emberColors.length) | 0], rot: 0, vr: 0, sway: Math.random() * 6.28,
        });
      }
    }

    g.clearRect(0, 0, this.w, this.h);
    const alive: P[] = [];
    for (const p of this.parts) {
      p.life += dt;
      if (p.life > p.max) continue;
      p.px = p.x; p.py = p.y;
      if (p.kind === "ember") {
        p.sway += dt * 2;
        p.x += (Math.sin(p.sway) * 0.6 * d) * k;
        p.y += p.vy * k;
      } else if (p.kind === "spark") {
        p.vx *= Math.pow(0.975, k); p.vy = p.vy * Math.pow(0.975, k) + 0.09 * d * k;
        p.x += p.vx * k; p.y += p.vy * k;
      } else if (p.kind === "rocket") {
        p.vy += 0.12 * d * k;
        p.x += p.vx * k; p.y += p.vy * k;
        if (p.y <= (p.targetY ?? 0) || p.vy >= -2 * d) {
          this.burst(p.x / this.w, p.y / this.h, this.rocketColors, 120, 0.9 + Math.random() * 0.4);
          this.onBurst?.(p.x / d, p.y / d);
          continue;
        }
      } else {
        p.sway += dt * 3;
        p.vy = Math.min(p.vy + 0.02 * d * k, 3.2 * d);
        p.x += (p.vx + Math.sin(p.sway) * 1.2 * d) * k; p.y += p.vy * k; p.rot += p.vr * k;
        if (p.y > this.h + 30 * d) continue;
      }
      alive.push(p);
    }
    this.parts = alive;

    // additive glow for light, normal blending for paper
    g.globalCompositeOperation = "lighter";
    for (const p of alive) {
      if (p.kind === "confetti") continue;
      const fadeOut = 1 - p.life / p.max;
      if (p.kind === "ember") {
        const a = Math.min(1, p.life * 2) * fadeOut * (0.6 + Math.random() * 0.4) * this.fade;
        const r = p.size * 4;
        const grad = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        grad.addColorStop(0, `rgba(${p.color},${a})`);
        grad.addColorStop(1, `rgba(${p.color},0)`);
        g.fillStyle = grad;
        g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      } else {
        const a = (p.kind === "rocket" ? 1 : fadeOut ** 1.4) * this.fade;
        g.strokeStyle = p.life < 0.12 && p.kind === "spark" ? `rgba(${this.hot},${a})` : `rgba(${p.color},${a})`;
        g.lineWidth = p.size;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(p.px - (p.x - p.px) * 2, p.py - (p.y - p.py) * 2);
        g.lineTo(p.x, p.y);
        g.stroke();
      }
    }
    g.globalCompositeOperation = "source-over";
    for (const p of alive) {
      if (p.kind !== "confetti") continue;
      const a = Math.min(1, (p.max - p.life) / 1.5) * this.fade;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.scale(1, Math.cos(p.sway * 1.7)); // 3D flip
      g.fillStyle = `rgba(${p.color},${a})`;
      g.fillRect(-p.size / 2, -p.size / 5, p.size, p.size / 2.5);
      g.restore();
    }

    if (alive.length || this.emberRate) this.raf = requestAnimationFrame(tt => this.frame(tt));
    else { this.raf = 0; g.clearRect(0, 0, this.w, this.h); }
  }
}

/** "#F1C24D" → "241,194,77" for rgba() strings. */
export function rgb(hex: string): string {
  const h = hex.trim().replace("#", "");
  const n = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16)).join(",");
}
