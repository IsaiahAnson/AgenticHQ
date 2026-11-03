/* Agentic HQ motion layer (2026-10-28), loaded last on os.html.
   It wraps the board's own global functions (toast, renderDeck, archiveSkill, findRender,
   renderUsage) and watches the DOM; it never changes data, storage keys, widget ids or orb colours.
   Every effect checks reduced motion live, and the one effects canvas only draws while
   something is actually moving. */
(() => {
  'use strict';
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = mq.matches;
  mq.addEventListener?.('change', e => { reduced = e.matches; });
  const $ = id => document.getElementById(id);
  const EASE = 'cubic-bezier(.2,0,0,1)', EASE_OUT = 'cubic-bezier(.4,0,1,1)';
  const g = name => { try { return typeof window[name] === 'function' ? window[name] : null; } catch (_) { return null; } };
  const orb = () => {
    let o; try { o = { x: orbCX(), y: orbCY(), r: RINGpx() }; } catch (_) { o = { x: innerWidth / 2, y: innerHeight / 2, r: 200 }; }
    try { const p = window.__orbMiniPose?.(); if (p && p.r > 4) { o.x = p.x; o.y = p.y; o.sr = p.r * .62; }  /* pose r is the orb's unit; the dotted sphere draws at about .62 of it */ } catch (_) {}
    if (!o.sr) o.sr = o.r * .45;
    return o;
  };
  const BALLS = () => { try { return balls; } catch (_) { return []; } };
  const glyphName = b => { try { return (GLYPH[b.glyph] || [])[0] || ''; } catch (_) { return ''; } };
  const centre = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, r }; };

  /* ---------- boot: stagger index, then drop the boot class once it has played ---------- */
  const root = document.documentElement;
  const stamp = () => {
    document.querySelectorAll('.w').forEach((w, i) => w.style.setProperty('--bi', Math.min(i, 12)));
    document.querySelectorAll('.oi').forEach((b, i) => b.style.setProperty('--bi', Math.min(i, 12)));
  };
  stamp();
  setTimeout(() => root.classList.remove('hq-boot'), reduced ? 200 : 1500);

  /* ---------- grain overlay and the effects canvas ---------- */
  const grain = document.createElement('div'); grain.id = 'hqGrain'; document.body.appendChild(grain);
  const fx = document.createElement('canvas'); fx.id = 'hqFx'; document.body.appendChild(fx);
  const fctx = fx.getContext('2d');
  let DPR = 1;
  const sizeFx = () => { DPR = (window.hqPR ? hqPR() : Math.min(devicePixelRatio || 1, 2)); fx.width = innerWidth * DPR; fx.height = innerHeight * DPR; fx.style.width = innerWidth + 'px'; fx.style.height = innerHeight + 'px'; };
  sizeFx();

  /* ---------- starfield depth: two sparse star bands over the base field, moved 1/2/3 px by the pointer ---------- */
  const bands = [2, 3].map((depth, k) => {
    const c = document.createElement('canvas'); c.className = 'hq-stars'; c.dataset.depth = depth;
    const hex = $('hexCv'); hex?.after(c); return c;
  });
  function drawBands() {
    const W = innerWidth, H = innerHeight, d = (window.hqPR ? hqPR() : Math.min(devicePixelRatio || 1, 2));
    bands.forEach((c, k) => {
      c.width = W * d; c.height = H * d; c.style.width = W + 'px'; c.style.height = H + 'px'; const x = c.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0);
      let seed = 11 + k * 6; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const n = Math.round(W * H / (k ? 70000 : 42000));
      for (let i = 0; i < n; i++) {
        const px = rnd() * W, py = rnd() * H, r = k ? 1.2 : .9, a = .25 + rnd() * .4;
        x.fillStyle = rnd() < .25 ? `rgba(163,124,255,${a})` : `rgba(214,224,255,${a})`;
        x.beginPath(); x.arc(px, py, r, 0, 6.2832); x.fill();
      }
    });
  }
  drawBands();
  const par = { tx: 0, ty: 0, x: 0, y: 0, on: false };
  addEventListener('pointermove', e => {
    if (reduced) return;
    par.tx = -(e.clientX / innerWidth - .5) * 2; par.ty = -(e.clientY / innerHeight - .5) * 2;
    if (!par.on) { par.on = true; requestAnimationFrame(parStep); }
  }, { passive: true });
  document.addEventListener('pointerleave', () => { par.tx = 0; par.ty = 0; });
  function parStep() {
    par.x += (par.tx - par.x) * .06; par.y += (par.ty - par.y) * .06;
    const hex = $('hexCv');
    if (hex) hex.style.transform = `translate3d(${par.x.toFixed(2)}px,${par.y.toFixed(2)}px,0)`;
    bands.forEach((c, k) => { const m = k + 2; c.style.transform = `translate3d(${(par.x * m).toFixed(2)}px,${(par.y * m).toFixed(2)}px,0)`; });
    if (Math.abs(par.tx - par.x) + Math.abs(par.ty - par.y) > .01) requestAnimationFrame(parStep); else par.on = false;
  }
  let rsT = 0;
  addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { sizeFx(); drawBands(); }, 150); });

  /* ---------- the effects loop: sparks, agent stream. Runs only while one of them is live ---------- */
  const FX = { sparks: [], stream: null, traces: [], running: false };
  window.__hqMotion = { FX };  /* read-only handle for checks */
  const kick = () => { if (!FX.running) { FX.running = true; requestAnimationFrame(loop); } };
  function loop(now) {
    fctx.setTransform(DPR, 0, 0, DPR, 0, 0); fctx.clearRect(0, 0, innerWidth, innerHeight);
    let live = false;
    if (FX.sparks.length) live = drawSparks(now) || live;
    if (FX.stream) live = drawStream(now) || live;
    if (FX.traces.length) live = drawTraces(now) || live;
    if (live) requestAnimationFrame(loop); else FX.running = false;
  }

  /* hero: a routine fired, so its ring ball sends a short spark burst to the ROUTINES panel */
  function burst(from, to, colour) {
    const t0 = performance.now();
    for (let i = 0; i < 14; i++) {
      FX.sparks.push({ t0: t0 + i * 18, d: 450, from, to, bend: (Math.random() - .5) * 140, colour, s: 1 + Math.random() * 1.4 });
    }
    kick();
  }
  function drawSparks(now) {
    FX.sparks = FX.sparks.filter(s => now - s.t0 < s.d);
    for (const s of FX.sparks) {
      const t = Math.max(0, (now - s.t0) / s.d), e = 1 - Math.pow(1 - t, 3);
      const mx = (s.from.x + s.to.x) / 2 + s.bend, my = (s.from.y + s.to.y) / 2 - Math.abs(s.bend) * .6;
      const x = (1 - e) * (1 - e) * s.from.x + 2 * (1 - e) * e * mx + e * e * s.to.x;
      const y = (1 - e) * (1 - e) * s.from.y + 2 * (1 - e) * e * my + e * e * s.to.y;
      fctx.globalAlpha = (1 - t) * .9; fctx.fillStyle = s.colour;
      fctx.beginPath(); fctx.arc(x, y, s.s, 0, 6.2832); fctx.fill();
    }
    fctx.globalAlpha = 1;
    return FX.sparks.length > 0;
  }
  let lastFired = null;
  const watchFired = () => {
    const tick = $('btick'); if (!tick) return;
    new MutationObserver(() => {
      const m = /(\d+)\s*\/\s*(\d+)\s*fired/.exec(tick.textContent || ''), n = m ? +m[1] : 0;
      if (lastFired !== null && n > lastFired) {
        const panel = $('w-rt');
        if (panel) {
          panel.classList.remove('hq-fired'); void panel.offsetWidth; panel.classList.add('hq-fired');
          if (!reduced) {
            const ball = BALLS().find(b => /RUN/.test(glyphName(b))) || null;
            const from = ball ? centre(ball.el) : orb();
            burst({ x: from.x, y: from.y }, centre(panel), 'rgba(79,213,138,1)');
          }
        }
      }
      lastFired = n;
    }).observe(tick, { childList: true, characterData: true, subtree: true });
  };
  watchFired();

  /* hero: while an agent session is working, a capped particle stream runs from the orb to AGENT USAGE */
  function drawStream(now) {
    const S = FX.stream, panel = $('w-yt');
    if (!panel || !panel.getClientRects().length) { FX.stream = null; return false; }
    const c = orb(), p = panel.getBoundingClientRect(), to = { x: p.left < c.x ? p.right : p.left, y: p.top + p.height / 2 };
    const ang = Math.atan2(to.y - c.y, to.x - c.x), o = { x: c.x + Math.cos(ang) * c.sr, y: c.y + Math.sin(ang) * c.sr };
    const c1 = { x: o.x + (to.x - o.x) * .35, y: o.y - 90 }, c2 = { x: o.x + (to.x - o.x) * .7, y: to.y + 40 };
    const at = e => {
      const u = 1 - e;
      return { x: u * u * u * o.x + 3 * u * u * e * c1.x + 3 * u * e * e * c2.x + e * e * e * to.x,
               y: u * u * u * o.y + 3 * u * u * e * c1.y + 3 * u * e * e * c2.y + e * e * e * to.y };
    };
    if (reduced) {
      fctx.save(); fctx.setLineDash([2, 5]); fctx.strokeStyle = 'rgba(127,240,255,.35)'; fctx.beginPath();
      fctx.moveTo(o.x, o.y); fctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y); fctx.stroke(); fctx.restore();
      return false;
    }
    const want = Math.min(40, 10 + S.n * 10);
    while (S.parts.length < want) S.parts.push({ t0: now - Math.random() * 1600, d: 1200 + Math.random() * 800, j: (Math.random() - .5) * 10 });
    if (S.parts.length > want) S.parts.length = want;
    for (const q of S.parts) {
      let t = (now - q.t0) / q.d; if (t >= 1) { q.t0 = now; t = 0; }
      const pt = at(t);
      fctx.globalAlpha = Math.sin(Math.PI * t) * .8; fctx.fillStyle = '#7ff0ff';
      fctx.beginPath(); fctx.arc(pt.x + q.j * Math.sin(t * 6), pt.y + q.j * Math.cos(t * 5), 1.1, 0, 6.2832); fctx.fill();
    }
    fctx.globalAlpha = 1;
    return true;
  }
  setInterval(() => {
    const n = document.querySelectorAll('#w-yt .sess[data-s="working"]').length;
    if (n && !document.hidden) { if (!FX.stream) FX.stream = { n, parts: [] }; FX.stream.n = n; kick(); }
    else if (FX.stream) { FX.stream = null; kick(); }
  }, 1000);

  /* skill round-trip: pressing play sends a violet comet from the card into the orb; when the job
     ends, a green (done) or red (failed) comet comes back to the same card. One each way, never while idle */
  function trace(from, to, colour, d) {
    FX.traces.push({ t0: performance.now(), d, from, to, colour });
    kick();
  }
  function drawTraces(now) {
    FX.traces = FX.traces.filter(q => now - q.t0 < q.d + 260);
    for (const q of FX.traces) {
      const o = typeof q.to === 'function' ? q.to() : q.to, f = typeof q.from === 'function' ? q.from() : q.from;
      const mx = (f.x + o.x) / 2, my = Math.min(f.y, o.y) - 40 - Math.min(80, Math.abs(o.x - f.x) * .12);   /* arc over, never through, the panels */
      const at = e => { const u = 1 - e; return { x: u * u * f.x + 2 * u * e * mx + e * e * o.x, y: u * u * f.y + 2 * u * e * my + e * e * o.y }; };
      const t = Math.min(1, (now - q.t0) / q.d), head = 1 - Math.pow(1 - t, 3);
      const tail = Math.max(0, head - .4), fade = t < 1 ? 1 : Math.max(0, 1 - (now - q.t0 - q.d) / 260);
      fctx.save(); fctx.lineCap = 'round';
      for (let k = 0; k < 14; k++) {                       /* tail: short segments brighten toward the head */
        const a = tail + (head - tail) * k / 14, b = tail + (head - tail) * (k + 1) / 14, p = at(a), r = at(b);
        fctx.globalAlpha = fade * .9 * ((k + 1) / 14); fctx.strokeStyle = q.colour; fctx.lineWidth = 1 + 2 * (k + 1) / 14;
        fctx.beginPath(); fctx.moveTo(p.x, p.y); fctx.lineTo(r.x, r.y); fctx.stroke();
      }
      const h = at(head);
      fctx.globalAlpha = fade; fctx.fillStyle = '#fff'; fctx.shadowColor = q.colour; fctx.shadowBlur = 16;
      fctx.beginPath(); fctx.arc(h.x, h.y, 2.8, 0, 6.2832); fctx.fill();
      if (t >= 1) {                                         /* landing ring at the target */
        const k = (now - q.t0 - q.d) / 260;
        fctx.shadowBlur = 0; fctx.globalAlpha = .6 * (1 - k); fctx.strokeStyle = q.colour; fctx.lineWidth = 1;
        fctx.beginPath(); fctx.arc(o.x, o.y, 4 + 18 * k, 0, 6.2832); fctx.stroke();
      }
      fctx.restore();
    }
    return FX.traces.length > 0;
  }
  const ps = g('playSkill');
  if (ps) window.playSkill = function (card, btn) {
    const fresh = card && !card.querySelector('.prog');
    const out = ps.apply(this, arguments);
    const bar = fresh && card.querySelector('.prog');
    if (bar && !reduced) {
      /* the effects canvas sits under the panels, so the comet meets the deck panel's edge level with the card, and the card's border flashes */
      const fromCard = () => {
        const b = card.getBoundingClientRect(), p = ($('w-sk') || card).getBoundingClientRect(), c = orb();
        return { x: p.left > c.x ? p.left - 2 : p.right + 2, y: Math.max(p.top + 8, Math.min(p.bottom - 8, b.top + b.height / 2)) };
      };
      const core = () => { const o = orb(); return { x: o.x, y: o.y }; };
      const flash = rgb => card.animate([{ boxShadow: `0 0 0 1px rgba(${rgb},.9), 0 0 18px rgba(${rgb},.45)` }, { boxShadow: `0 0 0 1px rgba(${rgb},0), 0 0 0 rgba(${rgb},0)` }], { duration: 520, easing: EASE });
      flash('163,124,255');
      trace(fromCard(), core, 'rgba(163,124,255,1)', 760);
      const mo = new MutationObserver(() => {
        const ok = bar.classList.contains('ok'), bad = bar.classList.contains('fail');
        if (!ok && !bad) return;
        mo.disconnect();
        const back = () => { trace(core(), fromCard, ok ? 'rgba(79,213,138,1)' : 'rgba(255,90,74,1)', 760); setTimeout(() => flash(ok ? '79,213,138' : '255,90,74'), 740); };
        const wait = 760 - (performance.now() - t0);        /* an instant failure waits for the outbound comet to land */
        wait > 0 ? setTimeout(back, wait) : back();
      });
      const t0 = performance.now();
      mo.observe(bar, { attributes: true, attributeFilter: ['class'] });
    }
    return out;
  };

  /* ---------- widgets: pointer-tracked specular, settle after a drop ---------- */
  let litW = null;
  addEventListener('pointermove', e => {
    const w = e.target.closest?.('.w');
    if (w !== litW) { litW?.classList.remove('hq-lit'); litW = w; w?.classList.add('hq-lit'); }
    if (w && !reduced) { const r = w.getBoundingClientRect(); w.style.setProperty('--mx', (e.clientX - r.left) + 'px'); w.style.setProperty('--my', (e.clientY - r.top) + 'px'); }
  }, { passive: true });
  const liveSeen = new WeakSet();
  new MutationObserver(list => {
    for (const m of list) {
      const w = m.target; if (!w.classList?.contains('w')) continue;
      if (w.classList.contains('live')) liveSeen.add(w);
      else if (liveSeen.has(w)) { liveSeen.delete(w); w.classList.remove('hq-settle'); void w.offsetWidth; w.classList.add('hq-settle'); setTimeout(() => w.classList.remove('hq-settle'), 300); }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });

  /* ---------- odometer digits for the email count, the home clock and usage percentages ---------- */
  function ticker(el, text, prev) {
    const frag = document.createDocumentFragment();
    [...text].forEach((ch, i) => {
      const s = document.createElement('span'); s.className = 'hq-dg'; s.textContent = ch;
      if (!reduced && prev != null && /\d/.test(ch) && prev[i] !== ch && prev.length === text.length) s.classList.add('roll');
      if (!reduced && prev != null && prev.length !== text.length && /\d/.test(ch)) s.classList.add('roll');
      frag.appendChild(s);
    });
    el._hqText = text; el.replaceChildren(frag); el.setAttribute('aria-label', text);
  }
  const TICK = '.bignum, #clkHome';
  const tickEl = el => {
    if (el.firstElementChild?.classList.contains('hq-dg') && el.textContent === el._hqText) return;
    const text = el.textContent, prev = el._hqText ?? null;
    if (text === prev) { ticker(el, text, text); return; }
    ticker(el, text, prev);
  };
  document.querySelectorAll(TICK).forEach(tickEl);
  new MutationObserver(list => {
    const seen = new Set();
    for (const m of list) {
      const t = m.target.nodeType === 3 ? m.target.parentElement : m.target;
      const el = t?.closest?.(TICK);
      if (el && !seen.has(el)) { seen.add(el); tickEl(el); }
      m.addedNodes.forEach(n => { if (n.nodeType === 1) n.querySelectorAll?.(TICK).forEach(x => { if (!seen.has(x)) { seen.add(x); tickEl(x); } }); });
    }
  }).observe(document.body, { childList: true, characterData: true, subtree: true });

  /* usage meters: bars grow from their old value (scaleX), percentages roll, lamps pop when they change */
  const ru = g('renderUsage');
  if (ru) window.renderUsage = function (w, d) {
    const old = new Map(), lamps = new Map();
    w?.querySelectorAll('.usage .meter').forEach((m, mi) => m.querySelectorAll('.ml').forEach((l, li) => {
      old.set(mi + ':' + li, { pct: l.querySelector('.pct')?.textContent, u: parseFloat(l.querySelector('.mbar > span')?.style.width) || 0 });
    }));
    w?.querySelectorAll('.usage .sess').forEach(s => lamps.set((s.querySelector('b')?.title || s.textContent.trim().slice(0, 40)), s.dataset.s));
    const out = ru.apply(this, arguments);
    w?.querySelectorAll('.usage .meter').forEach((m, mi) => m.querySelectorAll('.ml').forEach((l, li) => {
      const o = old.get(mi + ':' + li); if (!o) return;
      const pct = l.querySelector('.pct'), bar = l.querySelector('.mbar > span');
      if (pct && o.pct && pct.textContent !== o.pct) ticker(pct, pct.textContent, o.pct);
      const u = parseFloat(bar?.style.width) || 0;
      if (bar && !reduced && u > 0 && Math.abs(u - o.u) > .4) bar.animate([{ transform: `scaleX(${Math.max(.001, o.u / u)})` }, { transform: 'none' }], { duration: 260, easing: EASE });
    }));
    w?.querySelectorAll('.usage .sess').forEach(s => {
      const k = (s.querySelector('b')?.title || s.textContent.trim().slice(0, 40)), was = lamps.get(k);
      if (was && was !== s.dataset.s) s.querySelector('i')?.classList.add('hq-lamp');
    });
    return out;
  };

  /* ---------- Find: palette rows stagger when the query changes (not on arrow keys); a pill slides to the selection ---------- */
  const fr = g('findRender');
  let lastQ = null;
  const placePill = () => {
    const list = document.querySelector('.findhits'); if (!list) return;
    let pill = list.querySelector('.hq-pill');
    const on = list.querySelector('.hit-row.on');
    if (!pill) { pill = document.createElement('div'); pill.className = 'hq-pill'; pill.setAttribute('aria-hidden', 'true'); list.prepend(pill); }
    if (!on) { pill.style.opacity = '0'; return; }
    pill.style.opacity = '1'; pill.style.height = on.offsetHeight + 'px'; pill.style.transform = `translateY(${on.offsetTop}px)`;
    if (!pill._placed || reduced) { pill.style.transition = 'none'; void pill.offsetWidth; pill.style.transition = ''; pill._placed = true; }
  };
  if (fr) window.findRender = function () {
    const out = fr.apply(this, arguments);
    const input = document.querySelector('#find input'), list = document.querySelector('.findhits');
    const q = input ? input.value : '';
    if (list && q !== lastQ && !reduced) {
      list.classList.remove('hq-stagger');
      [...list.children].forEach((li, i) => li.style.setProperty('--i', Math.min(i, 12)));
      void list.offsetWidth; list.classList.add('hq-stagger');
      const pill = list.querySelector('.hq-pill'); if (pill) pill._placed = false;
    }
    lastQ = q;
    placePill();
    return out;
  };
  const fo = g('findOpen');
  if (fo) window.findOpen = function () { lastQ = null; return fo.apply(this, arguments); };

  /* ---------- Skills deck: FLIP on re-render, archive flight ---------- */
  const rd = g('renderDeck');
  if (rd) window.renderDeck = function () {
    const before = new Map();
    document.querySelectorAll('#deck .dk[data-id]').forEach(c => before.set(c.dataset.id, c.getBoundingClientRect()));
    const out = rd.apply(this, arguments);
    if (!reduced && before.size) document.querySelectorAll('#deck .dk[data-id]').forEach((c, i) => {
      const b = before.get(c.dataset.id), a = c.getBoundingClientRect();
      if (!b) { c.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE, delay: Math.min(i, 12) * 18, fill: 'backwards' }); return; }
      const dx = b.left - a.left, dy = b.top - a.top;
      if (Math.abs(dx) + Math.abs(dy) > 1) c.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 240, easing: EASE });
    });
    return out;
  };
  const as = g('archiveSkill');
  if (as) window.archiveSkill = function (id, on) {
    const card = on && !reduced ? document.querySelector(`#deck .dk[data-id="${CSS.escape(id)}"]`) : null;
    let ghost = null, from = null;
    if (card) {
      from = card.getBoundingClientRect(); ghost = card.cloneNode(true); ghost.classList.add('hq-fly');
      Object.assign(ghost.style, { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' });
      document.body.appendChild(ghost);
    }
    const out = as.apply(this, arguments);
    if (ghost) {
      const host = $('w-sk')?.getBoundingClientRect() || from;
      const tx = host.right - 40 - from.left, ty = host.bottom - 30 - from.top;
      ghost.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${tx}px,${ty}px) scale(.3)`, opacity: 0 }], { duration: 420, easing: EASE_OUT, fill: 'forwards' })
        .finished.finally(() => ghost.remove());
    }
    return out;
  };

  /* ---------- toasts: a queued stack instead of one reused box ---------- */
  const stack = document.createElement('div'); stack.id = 'hqToasts'; stack.setAttribute('role', 'status'); stack.setAttribute('aria-live', 'polite');
  document.body.appendChild(stack);
  window.toast = function (msg) {
    const t = document.createElement('div'); t.className = 'hq-toast'; t.textContent = msg;
    stack.appendChild(t);
    while (stack.children.length > 3) stack.firstElementChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), reduced ? 0 : 170); }, 2600);
  };

  /* ---------- routine switch confirm sweep ---------- */
  document.addEventListener('click', e => {
    const b = e.target.closest?.('.brow.rsw button'); if (!b) return;
    b.classList.remove('hq-sweep'); void b.offsetWidth; b.classList.add('hq-sweep');
    setTimeout(() => b.classList.remove('hq-sweep'), 600);
  });

  /* ---------- wheel: flash on commit (capture runs before the wheel's own pointerup) ---------- */
  addEventListener('pointerup', () => {
    try {
      if (WHEEL.held && WHEEL.quad >= 0) {
        const w = $('w-wheel'); if (!w) return;
        w.classList.remove('hq-commit'); void w.offsetWidth; w.classList.add('hq-commit');
        setTimeout(() => w.classList.remove('hq-commit'), 260);
      }
    } catch (_) {}
  }, true);

  /* ---------- ring echo: hovering a deck card or a widget lights the ring balls that belong to it ---------- */
  const ECHO = { 'w-rt': /RUN/, 'w-mail': /MAIL/, 'w-sk': /SKILL/ };
  let echoKey = '';
  const echo = (match) => {
    BALLS().forEach(b => b.el?.classList.toggle('hq-echo', !!match && match(b)));
  };
  document.addEventListener('pointerover', e => {
    const card = e.target.closest?.('#deck .dk[data-id]'), w = e.target.closest?.('.w');
    const key = card ? 'dk:' + card.dataset.id : w ? 'w:' + w.id : '';
    if (key === echoKey) return; echoKey = key;
    if (card) { const id = card.dataset.id.toLowerCase(); echo(b => String(b.artifact?.file || '').toLowerCase().startsWith(id)); }
    else if (w && ECHO[w.id]) { const re = ECHO[w.id]; echo(b => re.test(glyphName(b))); }
    else echo(null);
  });

  /* keep the boot stagger index right when the board rebuilds itself */
  const bw = g('buildWidgets');
  if (bw) window.buildWidgets = function () { const out = bw.apply(this, arguments); stamp(); return out; };
})();
