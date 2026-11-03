/* Agentic HQ "living" layer (2026-10-28), loaded after hq-motion.js.
   1. Ambient sky: three slow nebula glows that drift, a few twinkling stars, a dust mote or two and a
      rare shooting star, on one canvas between the starfield and the orb. 30 fps cap, stops while the tab
      is hidden or the Second Brain covers the page, one still frame under reduced motion.
   2. Agent Usage presses its own refresh button every 10 s while the page is visible (the server floors
      the fresh reads: Agent HQ 5 s, Codex 10 s, Claude API Org 60 s).
   3. Full screen without the window bar: the dock's expand button (or F11) puts the whole HQ in
      full screen; once chosen, the next click or key brings it back after a reload. */
(() => {
  const $ = id => document.getElementById(id);
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = mq.matches;

  /* ---------------- 1. ambient sky ---------------- */
  const cv = document.createElement('canvas'); cv.id = 'hqAmbient'; cv.setAttribute('aria-hidden', 'true');
  const stars = document.querySelectorAll('.hq-stars');
  (stars[stars.length - 1] || $('hexCv'))?.after(cv);
  const ctx = cv.getContext('2d');
  const neb = document.createElement('canvas'), nctx = neb.getContext('2d');
  const NS = .2, TAU = Math.PI * 2;
  const NEB = [
    { c:[70,60,170], x:.2, y:.3, r:.6, ax:.05, ay:.04, px:78, py:104, ph:0 },
    { c:[100,56,170], x:.82, y:.68, r:.52, ax:.04, ay:.05, px:96, py:71, ph:1.9 },
    { c:[34,108,150], x:.55, y:.14, r:.44, ax:.06, ay:.03, px:88, py:127, ph:3.4 }
  ];
  let W = 0, H = 0, DPR = 1, tw = [], motes = [], shot = null, nextShot = 0, last = 0, nebTick = 0, running = false;
  const t0 = performance.now();
  function size() {
    DPR = window.hqPR ? hqPR() : Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    neb.width = Math.max(2, Math.round(W * NS)); neb.height = Math.max(2, Math.round(H * NS));
    let seed = 29; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    tw = Array.from({ length: Math.round(W * H / 52000) }, () => ({ x: rnd() * W, y: rnd() * H, r: .7 + rnd() * .9,
      ph: rnd() * TAU, sp: .5 + rnd() * .9, v: rnd() < .3 }));
    motes = Array.from({ length: 7 }, () => ({ x: rnd() * W, y: rnd() * H, vx: (rnd() - .5) * 4, vy: -1.5 - rnd() * 3, r: .8 + rnd() * 1.2, ph: rnd() * TAU }));
  }
  function drawNebula(t) {
    const w = neb.width, h = neb.height;
    nctx.clearRect(0, 0, w, h); nctx.globalCompositeOperation = 'lighter';
    for (const n of NEB) {
      const cx = (n.x + n.ax * Math.sin(t / n.px * TAU + n.ph)) * w, cy = (n.y + n.ay * Math.cos(t / n.py * TAU + n.ph)) * h;
      const rr = n.r * Math.max(w, h), g = nctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      g.addColorStop(0, `rgba(${n.c},.075)`); g.addColorStop(.45, `rgba(${n.c},.035)`); g.addColorStop(1, `rgba(${n.c},0)`);
      nctx.fillStyle = g; nctx.fillRect(0, 0, w, h);
    }
    nctx.globalCompositeOperation = 'source-over';
  }
  function spawnShot(now) {
    const dir = Math.random() < .5 ? 1 : -1, a = (18 + Math.random() * 20) * Math.PI / 180;
    return { x: dir > 0 ? Math.random() * W * .5 : W - Math.random() * W * .5, y: Math.random() * H * .4,
      dx: Math.cos(a) * dir, dy: Math.sin(a), len: 110 + Math.random() * 120, dist: Math.hypot(W, H) * .35,
      dur: 700 + Math.random() * 400, t0: now };
  }
  function frame(now, still) {
    const t = (now - t0) / 1000, dt = Math.min(.1, (now - (last || now)) / 1000);
    if (still || (nebTick = (nebTick + 1) % 3) === 0) drawNebula(still ? 0 : t);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'low'; ctx.drawImage(neb, 0, 0, W, H);
    for (const s of tw) {
      const a = still ? .35 : .12 + .55 * Math.pow(.5 + .5 * Math.sin(t * s.sp * 1.6 + s.ph), 3);
      ctx.fillStyle = s.v ? `rgba(180,150,255,${a})` : `rgba(220,230,255,${a})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
      if (!still && a > .5) { ctx.fillStyle = `rgba(220,230,255,${(a - .5) * .5})`; ctx.fillRect(s.x - s.r * 3, s.y - .3, s.r * 6, .6); ctx.fillRect(s.x - .3, s.y - s.r * 3, .6, s.r * 6); }
    }
    if (!still) {
      for (const m of motes) {
        m.x += m.vx * dt; m.y += m.vy * dt;
        if (m.y < -10) { m.y = H + 10; m.x = Math.random() * W; } if (m.x < -10) m.x = W + 10; if (m.x > W + 10) m.x = -10;
        const a = .1 + .12 * (.5 + .5 * Math.sin(t * .7 + m.ph)), g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 5);
        g.addColorStop(0, `rgba(170,190,255,${a})`); g.addColorStop(1, 'rgba(170,190,255,0)');
        ctx.fillStyle = g; ctx.fillRect(m.x - m.r * 5, m.y - m.r * 5, m.r * 10, m.r * 10);
      }
      if (!shot && now > nextShot) { shot = spawnShot(now); nextShot = now + 22000 + Math.random() * 20000; }
      if (shot) {
        const p = (now - shot.t0) / shot.dur;
        if (p >= 1) shot = null;
        else {
          const e = 1 - Math.pow(1 - p, 2), hx = shot.x + shot.dx * shot.dist * e, hy = shot.y + shot.dy * shot.dist * e;
          const fade = p < .15 ? p / .15 : 1 - (p - .15) / .85, tl = shot.len * (.4 + .6 * Math.min(1, p * 3));
          const g = ctx.createLinearGradient(hx, hy, hx - shot.dx * tl, hy - shot.dy * tl);
          g.addColorStop(0, `rgba(235,240,255,${.75 * fade})`); g.addColorStop(.3, `rgba(170,190,255,${.3 * fade})`); g.addColorStop(1, 'rgba(170,190,255,0)');
          ctx.strokeStyle = g; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - shot.dx * tl, hy - shot.dy * tl); ctx.stroke();
        }
      }
    }
    last = now;
  }
  const idle = () => document.hidden || window.__copyPaused;
  function loop(now) {
    if (reduced || idle()) { running = false; return; }
    if (now - last >= 33) frame(now);
    requestAnimationFrame(loop);
  }
  function start() {
    if (reduced) { frame(performance.now(), true); return; }
    if (!running && !idle()) { running = true; last = 0; nextShot = performance.now() + 8000 + Math.random() * 10000; requestAnimationFrame(loop); }
  }
  size(); start();
  let rs = 0;
  addEventListener('resize', () => { clearTimeout(rs); rs = setTimeout(() => { size(); if (reduced) frame(performance.now(), true); }, 150); });
  document.addEventListener('visibilitychange', start);
  setInterval(start, 2000);   /* picks the loop back up after the Second Brain closes */
  mq.addEventListener?.('change', e => { reduced = e.matches; start(); });
  window.__hqAmbient = { running: () => running };

  /* ---------------- 2. Agent Usage: press refresh every 10 s ---------------- */
  setInterval(() => {
    if (idle()) return;
    const b = document.querySelector('#w-yt .usage-refresh');
    if (b && !b.disabled) b.click();
  }, 10000);

  /* ---------------- 3. full screen, no window bar ---------------- */
  const FSKEY = 'os-fullscreen';
  const topDoc = (() => { try { return window.top.document; } catch (_) { return document; } })();
  const isFs = () => !!topDoc.fullscreenElement;
  const paint = () => {
    document.body.classList.toggle('hq-fs', isFs());
    const b = $('fsBtn'); if (!b) return;
    b.innerHTML = ico(isFs() ? 'shrink' : 'expand');
    b.title = isFs() ? 'Leave full screen (Esc or F11)' : 'Full screen, no window bar (F11)';
    b.setAttribute('aria-label', b.title);
  };
  const enter = () => topDoc.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  const toggle = () => {
    if (isFs()) { copyStorage.setItem(FSKEY, '0'); topDoc.exitFullscreen?.().catch(() => {}); }
    else { copyStorage.setItem(FSKEY, '1'); enter(); }
  };
  document.addEventListener('click', e => { if (e.target.closest?.('#fsBtn')) { e.stopPropagation(); toggle(); } }, true);
  topDoc.addEventListener('fullscreenchange', paint);
  /* a browser needs a click or key before it allows full screen, so a saved choice waits for the first one */
  const resume = () => {
    removeEventListener('pointerdown', resume, true); removeEventListener('keydown', resume, true);
    if (copyStorage.getItem(FSKEY) === '1' && !isFs()) enter();
  };
  addEventListener('pointerdown', resume, true); addEventListener('keydown', resume, true);
  /* buildWidgets() rebuilds the dock (edit mode restores, layout resets): keep its icon right */
  new MutationObserver(() => { const b = $('fsBtn'); if (b && !b.dataset.hqp) { b.dataset.hqp = 1; paint(); } })
    .observe(document.body, { childList: true });
  paint();
})();
