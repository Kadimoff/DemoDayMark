/* munsif.im — interactions + interactive stage demo */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const html = document.documentElement;
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover:hover) and (pointer:fine)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad = (n) => String(n).padStart(2, '0');

  /* ---------- nav ---------- */
  const nav = $('#nav');
  const onScrollNav = () => nav.classList.toggle('scrolled', scrollY > 40);

  /* ---------- reveal ---------- */
  const groups = new Map();
  $$('.rv').forEach((el) => {
    const p = el.parentElement;
    const i = groups.get(p) || 0;
    groups.set(p, i + 1);
    el.style.setProperty('--d', Math.min(i * 0.08, 0.5) + 's');
  });
  const io = new IntersectionObserver((ents) => {
    ents.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  $$('.rv, .cta-final').forEach((el) => io.observe(el));
  // hero reveals immediately
  requestAnimationFrame(() => $$('.hero .rv').forEach((el) => el.classList.add('in')));

  /* ---------- hero overlays mapped onto the photo ---------- */
  const media = $('#heroMedia');
  const heroImg = $('.hero-img');
  const IW = 3168, IH = 1344;
  function layoutHero() {
    const cw = media.clientWidth, ch = media.clientHeight;
    const s = Math.max(cw / IW, ch / IH);
    const iw = IW * s, ih = IH * s;
    const pos = getComputedStyle(heroImg).objectPosition.split(' ');
    const px = parseFloat(pos[0]) / 100 || 0, py = parseFloat(pos[1] || '30') / 100;
    const ox = (cw - iw) * (isNaN(px) ? 0.5 : px), oy = (ch - ih) * py;
    $$('.hero-anchor', media).forEach((a) => {
      const x = +a.dataset.x, y = +a.dataset.y, r = +a.dataset.r;
      a.style.left = ox + x * s + 'px';
      a.style.top = oy + y * s + 'px';
      a.style.setProperty('--fs', (r * s * 0.235).toFixed(1) + 'px');
      a.style.setProperty('--lw', (r * s * 1.7).toFixed(1) + 'px');
    });
  }
  const heroTime = $('#heroTime');
  let heroLeft = 4 * 60 + 59;
  setInterval(() => {
    heroLeft = heroLeft <= 0 ? 299 : heroLeft - 1;
    heroTime.textContent = `00:${pad(Math.floor(heroLeft / 60))}:${pad(heroLeft % 60)}`;
  }, 1000);

  /* ---------- scroll-driven bits ---------- */
  const f5Media = $('#f5Media'), f5 = $('#final5');
  const stepsFill = $('#stepsFill'), stepsSec = $('#how');
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      onScrollNav();
      if (reduce()) return;
      const y = scrollY, vh = innerHeight;
      if (y < vh * 1.2) media.style.translate = `0 ${(y * 0.28).toFixed(1)}px`;
      const r = f5.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh) {
        const p = (vh - r.top) / (vh + r.height); // 0..1
        f5Media.style.translate = `0 ${((p - 0.5) * -120).toFixed(1)}px`;
        f5Media.style.scale = (1.12 - p * 0.1).toFixed(3);
      }
      const sr = stepsSec.getBoundingClientRect();
      const sp = clamp((vh * 0.85 - sr.top) / (sr.height * 0.9), 0, 1);
      stepsFill.style.setProperty('--p', sp.toFixed(3));
    });
  }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', () => { layoutHero(); onScroll(); });
  layoutHero(); onScroll();
  if (heroImg && !heroImg.complete) heroImg.addEventListener('load', layoutHero);

  /* ---------- final-5 countdown rail ---------- */
  const f5spans = $$('.f5-count span');
  let f5i = 0;
  setInterval(() => {
    f5spans.forEach((s, i) => s.classList.toggle('on', i === f5i));
    f5i = (f5i + 1) % (f5spans.length + 1);
  }, 1000);

  /* ---------- pointer: magnetic, cursor glow, tile spotlight ---------- */
  if (finePointer) {
    document.body.classList.add('has-cursor');
    const glow = $('.cursor-glow');
    let gx = innerWidth / 2, gy = innerHeight / 2, tx = gx, ty = gy;
    addEventListener('pointermove', (e) => { tx = e.clientX; ty = e.clientY; }, { passive: true });
    (function loop() {
      gx += (tx - gx) * 0.14; gy += (ty - gy) * 0.14;
      glow.style.transform = `translate(${gx.toFixed(1)}px,${gy.toFixed(1)}px)`;
      requestAnimationFrame(loop);
    })();
    $$('.magnetic').forEach((b) => {
      b.addEventListener('pointermove', (e) => {
        if (reduce()) return;
        const r = b.getBoundingClientRect();
        b.style.setProperty('--mx', ((e.clientX - r.left - r.width / 2) * 0.22).toFixed(1) + 'px');
        b.style.setProperty('--my', ((e.clientY - r.top - r.height / 2) * 0.3).toFixed(1) + 'px');
      });
      b.addEventListener('pointerleave', () => { b.style.setProperty('--mx', '0px'); b.style.setProperty('--my', '0px'); });
    });
    $$('.tile').forEach((t) => t.addEventListener('pointermove', (e) => {
      const r = t.getBoundingClientRect();
      t.style.setProperty('--x', e.clientX - r.left + 'px');
      t.style.setProperty('--y', e.clientY - r.top + 'px');
    }));
  }

  /* ---------- bento live bits ---------- */
  const miniArc = $('#miniArc'), miniTime = $('#miniTime'), phTime = $('#phTime');
  let mini = 120;
  const dl = $('#dl');
  let dlLeft = 2 * 3600 + 14 * 60 + 9;
  const scrT = $$('.scr .st');
  let sync = 42;
  setInterval(() => {
    mini = mini <= 0 ? 120 : mini - 1;
    const t = `${pad(Math.floor(mini / 60))}:${pad(mini % 60)}`;
    miniTime.textContent = t; phTime.textContent = t;
    miniArc.style.strokeDashoffset = (314.16 * (1 - mini / 120)).toFixed(2);
    dlLeft = dlLeft <= 0 ? 8049 : dlLeft - 1;
    dl.textContent = `${pad(Math.floor(dlLeft / 3600))}:${pad(Math.floor((dlLeft % 3600) / 60))}:${pad(dlLeft % 60)}`;
    sync = sync <= 0 ? 60 : sync - 1;
    scrT.forEach((s) => (s.textContent = `00:${pad(sync)}`));
  }, 1000);
  // leaderboard: gentle live re-ranking (FLIP)
  const lb = $('#lb');
  setInterval(() => {
    if (document.hidden || reduce()) return;
    const items = $$('li', lb);
    const first = new Map(items.map((li) => [li, li.getBoundingClientRect().top]));
    const pick = items[Math.floor(Math.random() * items.length)];
    let s = clamp(+pick.dataset.s + (Math.random() < 0.6 ? 0.2 : -0.1), 6.5, 9.6);
    pick.dataset.s = s.toFixed(1);
    pick.querySelector('span').textContent = s.toFixed(1);
    pick.querySelector('em').style.setProperty('--w', (s / 10).toFixed(2));
    items.sort((a, b) => b.dataset.s - a.dataset.s).forEach((li, i) => { li.querySelector('b').textContent = i + 1; lb.appendChild(li); });
    items.forEach((li) => {
      const dy = first.get(li) - li.getBoundingClientRect().top;
      if (!dy) return;
      li.style.transition = 'none'; li.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => { li.style.transition = ''; li.style.transform = ''; });
    });
  }, 3200);

  /* =========================================================
     INTERACTIVE STAGE DEMO — canvas, 60fps
     ========================================================= */
  const stage = $('#stage'), cv = $('#demoCanvas'), ctx = cv.getContext('2d');
  const btn = $('#demoStart'), btnLbl = $('.lbl', btn), sndBtn = $('#demoSound'), live = $('#demoLive');
  const T = { up: html.dataset.timesUp, next: html.dataset.next, on: html.dataset.soundOn, off: html.dataset.soundOff, start: html.dataset.start, reset: html.dataset.reset };
  const DUR = 10;
  let W = 0, H = 0, DPR = 1;
  let state = 'idle', t0 = 0, tBoom = 0, lastSec = 11, visible = false, raf = 0;
  let parts = [], waves = [], flash = 0, pulse = 0, rot = 0, lastNow = 0;
  let bub = { x: 0, y: 0, r: 0 };
  const COLORS = ['#7C5CFF', '#D46BC4', '#FFB020', '#FFE2A8'];

  // pre-rendered glow sprites
  const sprites = COLORS.map((c) => {
    const s = document.createElement('canvas'); s.width = s.height = 64;
    const g = s.getContext('2d'), rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, '#fff'); rg.addColorStop(0.18, c); rg.addColorStop(0.5, c + '55'); rg.addColorStop(1, c + '00');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64); return s;
  });

  function resize() {
    const r = stage.getBoundingClientRect();
    DPR = Math.min(devicePixelRatio || 1, 2);
    W = Math.round(r.width * DPR); H = Math.round(r.height * DPR);
    cv.width = W; cv.height = H;
    if (state === 'idle') draw(performance.now());
  }
  new ResizeObserver(resize).observe(stage);

  const ease = {
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    outBack: (p) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
  };

  // ---- audio (off by default)
  let ac = null, soundOn = false;
  function tone(freq, dur, type = 'sine', vol = 0.18, slide = 0) {
    if (!soundOn || !ac) return;
    const o = ac.createOscillator(), g = ac.createGain(), n = ac.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, n);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, n + dur);
    g.gain.setValueAtTime(0.0001, n); g.gain.exponentialRampToValueAtTime(vol, n + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, n + dur);
    o.connect(g).connect(ac.destination); o.start(n); o.stop(n + dur + 0.05);
  }
  function boomSound() {
    if (!soundOn || !ac) return;
    tone(140, 1.2, 'sine', 0.5, 38);
    const len = ac.sampleRate * 0.9, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    f.type = 'lowpass'; f.frequency.value = 1800; g.gain.value = 0.35;
    src.buffer = buf; src.connect(f).connect(g).connect(ac.destination); src.start();
    tone(660, 0.9, 'triangle', 0.12, 990);
  }
  sndBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    if (soundOn && !ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { soundOn = false; } }
    if (ac && ac.state === 'suspended') ac.resume();
    sndBtn.textContent = soundOn ? T.on : T.off;
    sndBtn.setAttribute('aria-pressed', String(soundOn));
  });

  // ---- particles
  function spawnRing(n, level) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.25 + Math.random() * 0.9) * bub.r * (0.6 + level * 0.18);
      const c = Math.random() < 0.25 + level * 0.12 ? (Math.random() < 0.5 ? 2 : 3) : Math.random() < 0.5 ? 0 : 1;
      parts.push({ x: bub.x + Math.cos(a) * bub.r, y: bub.y + Math.sin(a) * bub.r, vx: Math.cos(a) * sp - Math.sin(a) * sp * 0.35, vy: Math.sin(a) * sp + Math.cos(a) * sp * 0.35, life: 0, max: 0.7 + Math.random() * 1.1, s: (2 + Math.random() * 5 + level) * DPR, c });
    }
  }
  function spawnBurst(n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = (0.3 + Math.pow(Math.random(), 0.6) * 2.4) * H * 0.55;
      parts.push({ x: W / 2, y: H / 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 0.9 + Math.random() * 1.6, s: (3 + Math.random() * 9) * DPR, c: (Math.random() * 4) | 0, drag: 1.6 });
    }
  }

  function setBtn(mode) {
    btn.disabled = mode === 'run';
    btn.classList.toggle('is-reset', mode === 'done');
    btnLbl.textContent = mode === 'done' ? T.reset : T.start;
  }

  async function start() {
    if (state === 'run') return;
    try { await document.fonts.load('800 100px Unbounded', '0123456789:' + T.up); } catch (e) {}
    if (ac && ac.state === 'suspended') ac.resume();
    state = 'run'; t0 = performance.now(); lastSec = 11; parts = []; waves = []; flash = 0;
    stage.classList.add('running'); stage.classList.remove('final', 'shake');
    setBtn('run'); kick();
  }
  function reset() {
    state = 'idle'; parts = []; waves = []; flash = 0;
    stage.classList.remove('running', 'final', 'shake');
    setBtn('idle'); kick();
  }
  btn.addEventListener('click', () => (state === 'done' ? (reset(), start()) : start()));
  window.munsifDemo = { start, reset, seek(sec) { if (state === 'run') { t0 = performance.now() - sec * 1000; } }, get state() { return state; } };

  function kick() { if (!raf) { lastNow = performance.now(); raf = requestAnimationFrame(frame); } }
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible) kick(); }, { threshold: 0.05 }).observe(stage);

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - lastNow) / 1000); lastNow = now;
    update(now, dt); draw(now);
    if (visible || state === 'run') raf = requestAnimationFrame(frame);
  }

  function geometry(remaining) {
    const r0 = H * 0.115, m = H * 0.055;
    const small = { x: W - r0 - m, y: H - r0 - m, r: r0 };
    const big = { x: W / 2, y: H / 2, r: H * 0.33 };
    let k = 0;
    if (state === 'run') k = clamp((5.15 - remaining) / 0.55, 0, 1);
    if (state === 'boom' || state === 'done') k = 1;
    const e = reduce() ? (k > 0 ? 1 : 0) : ease.outBack(k);
    return { x: small.x + (big.x - small.x) * Math.min(e, 1), y: small.y + (big.y - small.y) * Math.min(e, 1), r: small.r + (big.r - small.r) * e, k };
  }

  function update(now, dt) {
    rot += dt;
    const rm = reduce();
    if (state === 'run') {
      const remaining = DUR - (now - t0) / 1000;
      const sec = Math.ceil(remaining);
      Object.assign(bub, geometry(remaining));
      if (sec !== lastSec && remaining > 0) {
        lastSec = sec;
        if (sec <= 5) {
          stage.classList.add('final');
          pulse = 1; waves.push({ r: bub.r, a: 0.9, w: 6 * DPR });
          tone(700 + (6 - sec) * 140, 0.16, 'square', 0.08);
          live.textContent = String(sec);
          if (!rm) spawnRing(40 + (6 - sec) * 30, 6 - sec);
        } else tone(520, 0.06, 'sine', 0.06);
      }
      if (remaining <= 5 && !rm) {
        const L = 6 - Math.max(1, Math.ceil(remaining));
        const rate = 18 * L * L + 40; // per second
        spawnRing(Math.round(rate * dt + Math.random()), L);
      } else if (!rm && Math.random() < dt * 6) spawnRing(1, 0);
      if (remaining <= 0) {
        state = 'boom'; tBoom = now; flash = 1;
        waves.push({ r: bub.r, a: 1, w: 14 * DPR }, { r: bub.r * 0.6, a: 0.8, w: 8 * DPR, delay: 0.12 }, { r: bub.r * 0.3, a: 0.6, w: 5 * DPR, delay: 0.26 });
        if (!rm) { spawnBurst(520); stage.classList.remove('shake'); void stage.offsetWidth; stage.classList.add('shake'); }
        boomSound(); live.textContent = T.up;
      }
    } else if (state === 'boom') {
      Object.assign(bub, geometry(0));
      if (now - tBoom > 2600) { state = 'done'; setBtn('done'); }
    } else if (state === 'idle') {
      Object.assign(bub, geometry(DUR));
      if (!rm && Math.random() < dt * 4) spawnRing(1, 0);
    } else Object.assign(bub, geometry(0));

    pulse = Math.max(0, pulse - dt * 2.2);
    flash = Math.max(0, flash - dt * 1.6);
    for (const w of waves) {
      if (w.delay > 0) { w.delay -= dt; continue; }
      w.r += (state === 'boom' ? H * 1.3 : H * 0.55) * dt; w.a -= dt * (state === 'boom' ? 0.75 : 1.1);
    }
    waves = waves.filter((w) => w.a > 0);
    for (const p of parts) {
      p.life += dt;
      const drag = Math.exp(-(p.drag || 0.9) * dt);
      p.vx *= drag; p.vy *= drag; p.vy += H * 0.04 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    parts = parts.filter((p) => p.life < p.max);
    if (parts.length > 2200) parts.splice(0, parts.length - 2200);
  }

  function arcGrad(x, y, r, warm) {
    const g = ctx.createLinearGradient(x - r, y + r, x + r, y - r);
    g.addColorStop(0, warm > 0.5 ? '#D46BC4' : '#7C5CFF');
    g.addColorStop(0.55, warm > 0.5 ? '#FF8A4C' : '#D46BC4');
    g.addColorStop(1, '#FFB020');
    return g;
  }

  function draw(now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!W) return;
    const running = state === 'run';
    const remaining = running ? Math.max(0, DUR - (now - t0) / 1000) : state === 'idle' ? DUR : 0;
    const k = bub.k || 0;
    const { x, y, r } = bub;

    // final-mode vignette pulse
    if (k > 0 && state !== 'idle') {
      const vg = ctx.createRadialGradient(x, y, r * 0.8, x, y, Math.max(W, H) * 0.75);
      vg.addColorStop(0, `rgba(255,176,32,${0.05 + pulse * 0.16})`);
      vg.addColorStop(1, 'rgba(11,11,20,0)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    }

    // shock waves
    ctx.globalCompositeOperation = 'lighter';
    for (const w of waves) {
      if (w.delay > 0) continue;
      ctx.beginPath(); ctx.arc(state === 'boom' || state === 'done' ? W / 2 : x, state === 'boom' || state === 'done' ? H / 2 : y, w.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,190,90,${Math.max(0, w.a) * 0.8})`; ctx.lineWidth = w.w; ctx.stroke();
    }
    // particles
    for (const p of parts) {
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = a * a;
      const s = p.s * (0.6 + a * 0.8) * 2.4;
      ctx.drawImage(sprites[p.c], p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (state === 'boom' || state === 'done') { drawTimesUp(now); return; }

    // orbit rings (multiply each second in final)
    const L = k > 0.5 ? 6 - Math.max(1, Math.ceil(remaining)) : 0;
    for (let i = 0; i < L; i++) {
      const rr = r * (1.14 + i * 0.12);
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot * (i % 2 ? -0.6 : 0.8) * (1 + i * 0.25));
      ctx.setLineDash([rr * 0.08, rr * (0.05 + i * 0.03)]);
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.strokeStyle = i % 2 ? `rgba(124,92,255,${0.55 - i * 0.07})` : `rgba(255,176,32,${0.6 - i * 0.08})`;
      ctx.lineWidth = Math.max(1.5 * DPR, r * (0.018 - i * 0.002));
      ctx.stroke(); ctx.restore();
    }

    // bubble body
    const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.1, x, y, r);
    body.addColorStop(0, 'rgba(40,34,72,.92)'); body.addColorStop(1, 'rgba(11,11,20,.88)');
    ctx.shadowColor = 'rgba(124,92,255,.55)'; ctx.shadowBlur = r * 0.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = body; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1, DPR); ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.stroke();

    // track + progress arc
    const lw = r * (k > 0.5 ? 0.075 : 0.1);
    const ar = r - lw * 1.1;
    ctx.beginPath(); ctx.arc(x, y, ar, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = lw; ctx.stroke();
    const frac = clamp(remaining / DUR, 0, 1);
    const a0 = -Math.PI / 2, a1 = a0 + Math.PI * 2 * frac;
    if (frac > 0.001) {
      ctx.save();
      ctx.shadowColor = k > 0.5 ? 'rgba(255,150,40,.9)' : 'rgba(255,176,32,.6)'; ctx.shadowBlur = r * (0.18 + pulse * 0.3);
      ctx.beginPath(); ctx.arc(x, y, ar, a0, a1); ctx.strokeStyle = arcGrad(x, y, r, k); ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();
      ctx.restore();
      // leading spark
      const sx = x + Math.cos(a1) * ar, sy = y + Math.sin(a1) * ar, ss = lw * 4;
      ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(sprites[3], sx - ss / 2, sy - ss / 2, ss, ss); ctx.globalCompositeOperation = 'source-over';
    }

    // digits
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (k < 0.5) {
      const sec = Math.ceil(remaining);
      ctx.font = `600 ${Math.round(r * 0.34)}px Unbounded, sans-serif`;
      ctx.fillStyle = '#F5F5FA';
      ctx.fillText(`00:${pad(sec)}`, x, y + r * 0.02);
      ctx.font = `600 ${Math.round(r * 0.12)}px Manrope, sans-serif`;
      ctx.fillStyle = 'rgba(245,245,250,.5)';
      ctx.fillText('munsif.im', x, y + r * 0.38);
    } else {
      const sec = Math.max(1, Math.ceil(remaining));
      const p = 1 - (remaining - (sec - 1)); // 0 → 1 across the second
      const rm = reduce();
      const sc = rm ? 1 : 1.6 - 0.72 * ease.outCubic(clamp(p, 0, 1));
      let al = 1;
      if (!rm) { if (p < 0.04) al = p / 0.04; else if (p > 0.9) al = Math.max(0, 1 - (p - 0.9) / 0.1); }
      const fs = r * 1.05 * sc;
      ctx.save();
      ctx.globalAlpha = al;
      // ghost trail
      if (!rm) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.font = `800 ${Math.round(fs * 1.18)}px Unbounded, sans-serif`;
        ctx.fillStyle = 'rgba(124,92,255,.22)'; ctx.fillText(String(sec), x - r * 0.025, y + r * 0.03);
        ctx.fillStyle = 'rgba(255,176,32,.2)'; ctx.fillText(String(sec), x + r * 0.025, y + r * 0.03);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.font = `800 ${Math.round(fs)}px Unbounded, sans-serif`;
      const g = ctx.createLinearGradient(x, y - fs / 2, x, y + fs / 2);
      g.addColorStop(0, '#FFF3D6'); g.addColorStop(0.55, '#FFB020'); g.addColorStop(1, '#FF6A3D');
      ctx.shadowColor = 'rgba(255,140,40,.9)'; ctx.shadowBlur = r * 0.35;
      ctx.fillStyle = g; ctx.fillText(String(sec), x, y + fs * 0.04);
      ctx.restore();
    }

    if (state === 'idle') {
      // breathing halo
      const br = 0.5 + 0.5 * Math.sin(now / 700);
      ctx.beginPath(); ctx.arc(x, y, r * (1.08 + br * 0.05), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(124,92,255,${0.15 + br * 0.2})`; ctx.lineWidth = 2 * DPR; ctx.stroke();
    }
  }

  function drawTimesUp(now) {
    const t = (now - tBoom) / 1000;
    if (flash > 0) { ctx.fillStyle = `rgba(255,236,200,${flash * 0.75})`; ctx.fillRect(0, 0, W, H); }
    const p = clamp(t / 0.7, 0, 1), e = reduce() ? 1 : ease.outBack(p);
    const fs = Math.min(W * 0.1, H * 0.2);
    ctx.save();
    ctx.translate(W / 2, H / 2 - fs * 0.15);
    ctx.scale(1.8 - 0.8 * e, 1.8 - 0.8 * e);
    ctx.globalAlpha = clamp(t / 0.25, 0, 1);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(fs)}px Unbounded, sans-serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(fs * (0.02 + (1 - e) * 0.2))}px`;
    const g = ctx.createLinearGradient(-fs * 3, 0, fs * 3, 0);
    g.addColorStop(0, '#9A7BFF'); g.addColorStop(0.5, '#FFD27A'); g.addColorStop(1, '#FFB020');
    ctx.shadowColor = 'rgba(255,150,40,.8)'; ctx.shadowBlur = fs * 0.5;
    ctx.fillStyle = g; ctx.fillText(T.up, 0, 0);
    ctx.restore();
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    if (t > 1.1) {
      ctx.globalAlpha = clamp((t - 1.1) / 0.5, 0, 1);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.round(fs * 0.2)}px Manrope, sans-serif`;
      ctx.fillStyle = 'rgba(245,245,250,.8)';
      ctx.fillText(T.next, W / 2, H / 2 + fs * 0.75);
      ctx.globalAlpha = 1;
    }
  }
  resize(); kick();
})();
