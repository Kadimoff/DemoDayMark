/* munsif.im: interactions, theme switch, team sign-in forms and the interactive stage demo
   Performance rules: nothing heavy before the first paint; heavy effects start on idle (html.fx);
   every timer/loop runs only while its section is on screen; scroll work is passive + one rAF per frame. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const html = document.documentElement;
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover:hover) and (pointer:fine)').matches;
  const small = () => innerWidth <= 700;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad = (n) => String(n).padStart(2, '0');
  const idle = (fn, timeout = 1500) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 200));

  /* ---------- visibility helper: run callbacks only while an element is near the viewport ---------- */
  const watchers = new Map();
  const vio = new IntersectionObserver((ents) => ents.forEach((e) => { const w = watchers.get(e.target); if (w) { w.on = e.isIntersecting; w.cb && w.cb(w.on); } }), { rootMargin: '120px 0px' });
  function watch(el, cb) { if (!el) return { on: false }; const w = { on: false, cb }; watchers.set(el, w); vio.observe(el); return w; }
  // one shared 1-second clock for every ticking widget; each widget declares the section it lives in
  const tickers = [];
  setInterval(() => { if (document.hidden) return; for (const t of tickers) if (t.w.on) t.fn(); }, 1000);
  const every1s = (el, fn) => tickers.push({ w: watch(el), fn });

  /* ---------- heavy effects after the first paint ---------- */
  const startFx = () => { if (!reduce()) html.classList.add('fx'); };
  if (document.readyState === 'complete') idle(startFx); else addEventListener('load', () => idle(startFx), { once: true });

  /* ---------- nav ---------- */
  const nav = $('#nav');
  let navOn = null;
  const onScrollNav = () => { const s = scrollY > 40; if (s !== navOn) { navOn = s; nav.classList.toggle('scrolled', s); } };
  // A narrow phone or a big system font can make the header row wider than the screen. Drop items step by step
  // (t1: section links + pricing pill, t2: current-language label, t3: short team label, t4: logo mark only,
  // t5: team pill) until it fits.
  const navIn = $('.nav-in'), NAV_STEPS = ['t1', 't2', 't3', 't4', 't5'];
  const fitNav = () => {
    nav.classList.remove(...NAV_STEPS);
    for (const c of NAV_STEPS) { if (navIn.scrollWidth <= navIn.clientWidth + 1) break; nav.classList.add(c); }
  };
  let fitRaf = 0;
  const fitSoon = () => { if (!fitRaf) fitRaf = requestAnimationFrame(() => { fitRaf = 0; fitNav(); }); };
  fitNav();
  addEventListener('resize', fitSoon, { passive: true });
  if (document.fonts) document.fonts.ready.then(fitSoon);
  addEventListener('load', () => { fitSoon(); setTimeout(fitSoon, 1500); }, { once: true });

  /* ---------- theme: light / dark, key shared with the app; the inline head script already set data-theme ---------- */
  const THEME_KEY = 'ij.theme';
  const themeBtn = $('#themeBtn'), metaTheme = $('meta[name="theme-color"]');
  const curTheme = () => (html.dataset.theme === 'light' ? 'light' : 'dark');
  // phone screenshots follow the theme; they are lazy, so swapping before they load costs nothing
  const phoneSrc = (t) => $$('.device-screen [data-' + t + ']').forEach((el) => {
    const v = el.dataset[t];
    if (el.tagName === 'SOURCE') { if (el.getAttribute('srcset') !== v) el.setAttribute('srcset', v); }
    else if (el.getAttribute('src') !== v) el.setAttribute('src', v);
  });
  const applyTheme = (t) => {
    html.dataset.theme = t;
    if (metaTheme) metaTheme.setAttribute('content', t === 'light' ? '#F6F5FB' : '#0B0B14');
    if (themeBtn) { const l = themeBtn.dataset[t === 'light' ? 'dark' : 'light']; themeBtn.setAttribute('aria-label', l); themeBtn.title = l; }
    phoneSrc(t);
  };
  applyTheme(curTheme());
  if (themeBtn) themeBtn.addEventListener('click', () => {
    const t = curTheme() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* private mode */ }
    applyTheme(t);
  });
  const sysLight = matchMedia('(prefers-color-scheme: light)');
  const onSys = () => { let s = null; try { s = localStorage.getItem(THEME_KEY); } catch (e) { /* */ } if (s !== 'light' && s !== 'dark') applyTheme(sysLight.matches ? 'light' : 'dark'); };
  if (sysLight.addEventListener) sysLight.addEventListener('change', onSys);

  /* ---------- team sign-in: code -> /t/<code>, event code -> /o/<slug>/team (app routes) ---------- */
  // The app origin comes from the coordinator link, so the same file works here and when served by the app itself.
  const appBase = (() => { const a = $('#coordLink'); try { return new URL(a.getAttribute('href'), location.href).origin; } catch (e) { return location.origin; } })();
  const formGo = (form, inputSel, errSel, parse, path) => {
    if (!form) return;
    const inp = $(inputSel, form), err = $(errSel, form);
    inp.addEventListener('input', () => { err.textContent = ''; inp.removeAttribute('aria-invalid'); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = parse(inp.value.trim());
      if (!v) { err.textContent = err.dataset.msg; inp.setAttribute('aria-invalid', 'true'); inp.focus(); return; }
      location.href = appBase + path(v);
    });
  };
  // same rules as the app: a pasted link or a bare code, spaces/dashes ignored, 12 letters/digits
  formGo($('#codeForm'), '#teamCode', '#codeErr', (s) => {
    const m = s.match(/(?:\/t\/)?([A-Za-z0-9][A-Za-z0-9 -]{10,30})\/?(?:[?#].*)?$/);
    const c = m ? m[1].replace(/[\s-]/g, '').toUpperCase() : '';
    return /^[A-Z0-9]{12}$/.test(c) ? c : '';
  }, (c) => '/t/' + c);
  // event code = the organisation slug from /o/<slug>/..., a pasted registration link works too
  formGo($('#regForm'), '#regSlug', '#regErr', (s) => {
    const m = s.match(/\/o\/([^/?#\s]+)/);
    const slug = (m ? m[1] : s).toLowerCase();
    return /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(slug) ? slug : '';
  }, (s) => '/o/' + encodeURIComponent(s) + '/team');

  /* ---------- reveal (once) ---------- */
  const groups = new Map();
  $$('.rv').forEach((el) => {
    const p = el.parentElement;
    const i = groups.get(p) || 0;
    groups.set(p, i + 1);
    el.style.setProperty('--d', Math.min(i * 0.07, 0.42) + 's');
  });
  const io = new IntersectionObserver((ents) => {
    ents.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  $$('.rv, .cta-final').forEach((el) => io.observe(el));

  /* ---------- hero: overlays are placed by CSS (container units); JS only as a fallback ---------- */
  const media = $('#heroMedia');
  if (!(window.CSS && CSS.supports('width', '1cqw'))) {
    const heroImg = $('.hero-img'), IW = 3168, IH = 1344;
    const layoutHero = () => {
      const cw = media.clientWidth, ch = media.clientHeight, s = Math.max(cw / IW, ch / IH);
      const px = innerWidth > 1080 ? 0.04 : 0.5;
      const ox = (cw - IW * s) * px, oy = (ch - IH * s) * 0.3;
      $$('.hero-anchor', media).forEach((a) => {
        const r = +a.dataset.r;
        a.style.left = ox + +a.dataset.x * s + 'px';
        a.style.top = oy + +a.dataset.y * s + 'px';
        a.style.setProperty('--fs', (r * s * 0.235).toFixed(1) + 'px');
        a.style.setProperty('--lw', (r * s * 1.7).toFixed(1) + 'px');
      });
    };
    requestAnimationFrame(layoutHero);
    addEventListener('resize', layoutHero);
    if (heroImg && !heroImg.complete) heroImg.addEventListener('load', layoutHero);
  }
  const heroTime = $('#heroTime');
  let heroLeft = 4 * 60 + 59;
  every1s($('#top'), () => {
    heroLeft = heroLeft <= 0 ? 299 : heroLeft - 1;
    heroTime.textContent = `00:${pad(Math.floor(heroLeft / 60))}:${pad(heroLeft % 60)}`;
  });

  /* ---------- ticker runs only on screen ---------- */
  const ticker = $('.ticker');
  watch(ticker, (on) => ticker.classList.toggle('off', !on));

  /* ---------- scroll-driven bits ----------
     Where the browser supports scroll timelines, the hero parallax and the steps line run in CSS (compositor);
     otherwise: one passive listener, one rAF per frame, no layout reads (geometry is cached). */
  const stepsFill = $('#stepsFill'), stepsSec = $('#how');
  const cssScroll = !!(window.CSS && CSS.supports('animation-timeline: scroll()'));
  if (cssScroll) html.classList.add('sda');
  // hero parallax: desktop with a fine pointer only (touch scrolling + main-thread parallax = jitter)
  const parallax = !cssScroll && finePointer && !small();
  let geo = null;
  const measure = () => { const r = stepsSec.getBoundingClientRect(); geo = { top: r.top + scrollY, h: r.height }; };
  const stepsW = watch(stepsSec, (on) => { if (on && !cssScroll) measure(); });
  addEventListener('resize', () => { geo = null; }, { passive: true });
  let ticking = false, lastP = -1;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      onScrollNav();
      if (cssScroll || reduce()) return;
      const y = scrollY, vh = innerHeight;
      if (parallax && y < vh * 1.2) media.style.translate = `0 ${(y * 0.28).toFixed(1)}px`;
      if (stepsW.on) {
        if (!geo) measure();
        const sp = +clamp((vh * 0.85 - (geo.top - y)) / (geo.h * 0.9), 0, 1).toFixed(3);
        if (sp !== lastP) { lastP = sp; stepsFill.style.setProperty('--p', sp); }
      }
    });
  }
  addEventListener('scroll', onScroll, { passive: true });
  onScrollNav();

  /* ---------- pointer: magnetic buttons, cursor glow, tile spotlight (desktop only, after idle) ---------- */
  if (finePointer) idle(() => {
    document.body.classList.add('has-cursor');
    const glow = $('.cursor-glow');
    let gx = innerWidth / 2, gy = innerHeight / 2, tx = gx, ty = gy, glowRaf = 0;
    const glowLoop = () => {
      gx += (tx - gx) * 0.16; gy += (ty - gy) * 0.16;
      glow.style.transform = `translate3d(${gx.toFixed(1)}px,${gy.toFixed(1)}px,0)`;
      glowRaf = Math.abs(tx - gx) + Math.abs(ty - gy) > 0.6 ? requestAnimationFrame(glowLoop) : 0;
    };
    addEventListener('pointermove', (e) => { tx = e.clientX; ty = e.clientY; if (!glowRaf && html.classList.contains('fx')) glowRaf = requestAnimationFrame(glowLoop); }, { passive: true });
    $$('.magnetic').forEach((b) => {
      let r = null;
      b.addEventListener('pointerenter', () => { r = b.getBoundingClientRect(); });
      b.addEventListener('pointermove', (e) => {
        if (reduce() || !r) return;
        b.style.setProperty('--mx', ((e.clientX - r.left - r.width / 2) * 0.22).toFixed(1) + 'px');
        b.style.setProperty('--my', ((e.clientY - r.top - r.height / 2) * 0.3).toFixed(1) + 'px');
      }, { passive: true });
      b.addEventListener('pointerleave', () => { r = null; b.style.setProperty('--mx', '0px'); b.style.setProperty('--my', '0px'); });
    });
    $$('.tile').forEach((t) => {
      let raf = 0, ex = 0, ey = 0;
      t.addEventListener('pointermove', (e) => {
        ex = e.clientX; ey = e.clientY;
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; const r = t.getBoundingClientRect(); t.style.setProperty('--x', ex - r.left + 'px'); t.style.setProperty('--y', ey - r.top + 'px'); });
      }, { passive: true });
    });
  });

  /* ---------- bento live bits (only while the features section is on screen) ---------- */
  const feat = $('#features');
  const miniArc = $('#miniArc'), miniTime = $('#miniTime'), phTime = $('#phTime');
  let mini = 120;
  const dl = $('#dl');
  let dlLeft = 2 * 3600 + 14 * 60 + 9;
  const scrT = $$('.scr .st');
  let sync = 42;
  every1s(feat, () => {
    mini = mini <= 0 ? 120 : mini - 1;
    const t = `${pad(Math.floor(mini / 60))}:${pad(mini % 60)}`;
    miniTime.textContent = t; phTime.textContent = t;
    miniArc.style.strokeDashoffset = (314.16 * (1 - mini / 120)).toFixed(2);
    dlLeft = dlLeft <= 0 ? 8049 : dlLeft - 1;
    dl.textContent = `${pad(Math.floor(dlLeft / 3600))}:${pad(Math.floor((dlLeft % 3600) / 60))}:${pad(dlLeft % 60)}`;
    sync = sync <= 0 ? 60 : sync - 1;
    scrT.forEach((s) => (s.textContent = `00:${pad(sync)}`));
  });
  // leaderboard: gentle live re-ranking (FLIP), only when visible
  const lb = $('#lb');
  const lbW = watch(lb);
  setInterval(() => {
    if (document.hidden || reduce() || !lbW.on) return;
    const items = $$('li', lb);
    const first = new Map(items.map((li) => [li, li.offsetTop]));
    const pick = items[Math.floor(Math.random() * items.length)];
    const s = clamp(+pick.dataset.s + (Math.random() < 0.6 ? 0.2 : -0.1), 6.5, 9.6);
    pick.dataset.s = s.toFixed(1);
    pick.querySelector('span').textContent = s.toFixed(1);
    pick.querySelector('em').style.setProperty('--w', (s / 10).toFixed(2));
    items.sort((a, b) => b.dataset.s - a.dataset.s).forEach((li, i) => { li.querySelector('b').textContent = i + 1; lb.appendChild(li); });
    items.forEach((li) => {
      const dy = first.get(li) - li.offsetTop;
      if (!dy) return;
      li.style.transition = 'none'; li.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => { li.style.transition = ''; li.style.transform = ''; }));
    });
  }, 3200);

  /* =========================================================
     INTERACTIVE STAGE DEMO: canvas, draws only while visible (or running)
     ========================================================= */
  const stage = $('#stage'), cv = $('#demoCanvas'), ctx = cv.getContext('2d');
  const btn = $('#demoStart'), btnLbl = $('.lbl', btn), sndBtn = $('#demoSound'), live = $('#demoLive');
  const T = { up: html.dataset.timesUp, next: html.dataset.next, on: html.dataset.soundOn, off: html.dataset.soundOff, start: html.dataset.start, reset: html.dataset.reset };
  const DUR = 10;
  // lite mode: phones and low-core devices get fewer particles and a lower canvas resolution
  const lite = small() || (navigator.hardwareConcurrency || 8) <= 4;
  const PMAX = lite ? 900 : 2000, PK = lite ? 0.5 : 1;
  let W = 0, H = 0, DPR = 1;
  let state = 'idle', t0 = 0, tBoom = 0, lastSec = 11, visible = false, raf = 0, lastDraw = 0;
  let parts = [], waves = [], flash = 0, pulse = 0, rot = 0, lastNow = 0;
  const bub = { x: 0, y: 0, r: 0, k: 0 };
  const COLORS = ['#7C5CFF', '#D46BC4', '#FFB020', '#FFE2A8'];

  // pre-rendered glow sprites (replace costly shadowBlur)
  const sprites = COLORS.map((c) => {
    const s = document.createElement('canvas'); s.width = s.height = 64;
    const g = s.getContext('2d'), rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, '#fff'); rg.addColorStop(0.18, c); rg.addColorStop(0.5, c + '55'); rg.addColorStop(1, c + '00');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64); return s;
  });
  const halo = (() => {
    const s = document.createElement('canvas'); s.width = s.height = 128;
    const g = s.getContext('2d'), rg = g.createRadialGradient(64, 64, 20, 64, 64, 64);
    rg.addColorStop(0, 'rgba(124,92,255,.55)'); rg.addColorStop(0.6, 'rgba(124,92,255,.18)'); rg.addColorStop(1, 'rgba(124,92,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 128, 128); return s;
  })();

  function resize() {
    const r = stage.getBoundingClientRect();
    DPR = Math.min(devicePixelRatio || 1, lite ? 1.5 : 2);
    W = Math.round(r.width * DPR); H = Math.round(r.height * DPR);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    if (state === 'idle' && visible) draw(performance.now());
  }
  new ResizeObserver(resize).observe(stage);

  const ease = {
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
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
    n = Math.round(n * PK);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.25 + Math.random() * 0.9) * bub.r * (0.6 + level * 0.18);
      const c = Math.random() < 0.25 + level * 0.12 ? (Math.random() < 0.5 ? 2 : 3) : Math.random() < 0.5 ? 0 : 1;
      parts.push({ x: bub.x + Math.cos(a) * bub.r, y: bub.y + Math.sin(a) * bub.r, vx: Math.cos(a) * sp - Math.sin(a) * sp * 0.35, vy: Math.sin(a) * sp + Math.cos(a) * sp * 0.35, life: 0, max: 0.7 + Math.random() * 1.1, s: (2 + Math.random() * 5 + level) * DPR, c });
    }
  }
  function spawnBurst(n) {
    n = Math.round(n * PK);
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
    try { await document.fonts.load('800 100px Unbounded', '0123456789:' + T.up); } catch (e) { /* fallback font */ }
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible) kick(); });

  function frame(now) {
    raf = 0;
    if (document.hidden) return;
    const dt = Math.min(0.05, (now - lastNow) / 1000); lastNow = now;
    update(now, dt);
    // the idle bubble only breathes: 30 fps is plenty; the countdown itself renders every frame
    if (state !== 'idle' || now - lastDraw > 31) { draw(now); lastDraw = now; }
    if (visible || state === 'run' || state === 'boom') raf = requestAnimationFrame(frame);
  }

  function geometry(remaining) {
    const r0 = H * 0.115, m = H * 0.055;
    const sm = { x: W - r0 - m, y: H - r0 - m, r: r0 };
    const big = { x: W / 2, y: H / 2, r: H * 0.33 };
    let k = 0;
    if (state === 'run') k = clamp((5.15 - remaining) / 0.55, 0, 1);
    if (state === 'boom' || state === 'done') k = 1;
    const e = reduce() ? (k > 0 ? 1 : 0) : ease.outBack(k);
    return { x: sm.x + (big.x - sm.x) * Math.min(e, 1), y: sm.y + (big.y - sm.y) * Math.min(e, 1), r: sm.r + (big.r - sm.r) * e, k };
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
        spawnRing(rate * dt + Math.random(), L);
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
    if (parts.length > PMAX) parts.splice(0, parts.length - PMAX);
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

    // shock waves + particles
    ctx.globalCompositeOperation = 'lighter';
    for (const w of waves) {
      if (w.delay > 0) continue;
      ctx.beginPath(); ctx.arc(state === 'boom' || state === 'done' ? W / 2 : x, state === 'boom' || state === 'done' ? H / 2 : y, w.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,190,90,${Math.max(0, w.a) * 0.8})`; ctx.lineWidth = w.w; ctx.stroke();
    }
    for (const p of parts) {
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = a * a;
      const s = p.s * (0.6 + a * 0.8) * 2.4;
      ctx.drawImage(sprites[p.c], p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    if (state === 'boom' || state === 'done') { ctx.globalCompositeOperation = 'source-over'; drawTimesUp(now); return; }

    // bubble glow (sprite instead of shadowBlur)
    const hs = r * 3.1;
    ctx.globalAlpha = 0.85; ctx.drawImage(halo, x - hs / 2, y - hs / 2, hs, hs); ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

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
    body.addColorStop(0, 'rgba(40,34,72,.94)'); body.addColorStop(1, 'rgba(11,11,20,.9)');
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = body; ctx.fill();
    ctx.lineWidth = Math.max(1, DPR); ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.stroke();

    // track + progress arc (glow = a wide translucent stroke under the arc)
    const lw = r * (k > 0.5 ? 0.075 : 0.1);
    const ar = r - lw * 1.1;
    ctx.beginPath(); ctx.arc(x, y, ar, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = lw; ctx.stroke();
    const frac = clamp(remaining / DUR, 0, 1);
    const a0 = -Math.PI / 2, a1 = a0 + Math.PI * 2 * frac;
    if (frac > 0.001) {
      const grad = arcGrad(x, y, r, k);
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.22 + pulse * 0.25;
      ctx.beginPath(); ctx.arc(x, y, ar, a0, a1); ctx.strokeStyle = grad; ctx.lineWidth = lw * 2.6; ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, y, ar, a0, a1); ctx.lineWidth = lw; ctx.stroke();
      ctx.lineCap = 'butt';
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
      ctx.shadowColor = 'rgba(255,140,40,.9)'; ctx.shadowBlur = lite ? 0 : r * 0.3;
      ctx.fillStyle = g; ctx.fillText(String(sec), x, y + fs * 0.04);
      ctx.restore();
    }

    if (state === 'idle') {
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
    ctx.shadowColor = 'rgba(255,150,40,.8)'; ctx.shadowBlur = lite ? fs * 0.2 : fs * 0.5;
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
})();
