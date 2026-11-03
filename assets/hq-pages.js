/* Agentic HQ widget pages (2026-10-28). Loaded last, after hq-living.js.
   The dock under the title has one button per widget: Automation Pulse, What HQ Learned, Micro Apps,
   Skills Deck, Routines and Voice. Each opens a full page with more room: headline numbers, charts,
   full names, explanations and the same actions the widget has. Every page carries a small "Show on
   home" switch you can drag anywhere; turning it off moves the widget into the layout's removed[]
   list (its spot is kept), turning it on puts it back. Data comes from the same /api feeds.
   Needs you is the one page with no widget behind it: it gathers skill fixes, voice calls, email and
   routines that missed or failed, so it has no dock button and no "Show on home" switch.
   Clock times people read are 12-hour through window.HQTime (assets/time12.js).
   Uses os.html globals: LAY, DEFLAY, save, buildWidgets, LIVE_STATE, RDATA, SKILLS, SKST, MODELS,
   EFFORTS, api, API, escH, ico, toast, openApp, playSkill, modelBadge, APP_ICON, COMPANIONS, PULSE_WORD. */
(() => {
  const $ = id => document.getElementById(id);
  const E = s => escH(s);
  const PAGES = {
    'w-pulse':   { title: 'Automation Pulse', sub: 'Every automation, its last 7 days, and whether its reports get used', feed: '/api/pulse' },
    'w-learned': { title: 'What HQ Learned', sub: 'Every lesson kept in permanent standings, ranked by the strongest skill recommendation', feed: '/api/learned' },
    'w-apps':    { title: 'Micro Apps', sub: 'Your local apps and the companion services HQ leans on', feed: '/api/apps' },
    'w-sk':      { title: 'Skills Deck', sub: 'One-press agent jobs: what each does, who runs it, and how its runs went', feed: '/api/skills' },
    'w-rt':      { title: 'Routines', sub: "Today's scheduled fires, their health, and every routine's on/off switch", feed: '/api/routines' },
    'w-voice':   { title: 'Voice', sub: 'What came out of your voice sessions: decisions, open questions, the build queue and what got built', feed: '/api/voice' },
    'needs':     { title: 'Needs you', sub: 'Everything waiting on you: skill fixes, voice calls, email, and routines that missed or failed', feed: null, page: true }
  };
  const state = { id: null, data: null, filter: 'all', q: '', timer: 0 };
  /* collapsed/expanded state for the Pulse groups; lives as long as the page module does */
  const openGroups = { quiet: false, retired: false };

  /* ---------- shell ---------- */
  const root = document.createElement('div');
  root.id = 'hqPage'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.hidden = true;
  root.innerHTML = `<div class="pg-shell"><header class="pg-head"><span class="pg-ic"></span>
      <div class="pg-tt"><h2></h2><p></p></div>
      <div class="pg-acts"><span class="pg-upd"></span>
        <button type="button" class="pg-btn" data-act="refresh" title="Refresh this page" aria-label="Refresh this page">${ico('refresh')}</button>
        <button type="button" class="pg-btn" data-act="close" title="Close (Esc)" aria-label="Close page">${ico('x')}</button></div></header>
      <div class="pg-body"></div></div>
    <div class="pg-toggle" title="Drag to move"><span class="pg-grip" aria-hidden="true">⠿</span>
      <span class="pg-tlab">Show on home</span>
      <button type="button" class="pg-sw" role="switch" aria-checked="true" aria-label="Show this widget on the home page"><i></i></button></div>`;
  document.body.appendChild(root);
  const body = root.querySelector('.pg-body');

  /* ---------- widget on/off (layout removed[] list) ---------- */
  const onHome = id => LAY.widgets.some(w => w.id === id);
  function setHome(id, on) {
    if (!PAGES[id] || PAGES[id].page) return;   /* Needs you is a page, not a widget: no home spot */
    if (on === onHome(id)) return;
    LAY.removed = LAY.removed || [];
    if (on) {
      const i = LAY.removed.findIndex(w => w.id === id);
      const w = i >= 0 ? LAY.removed.splice(i, 1)[0] : JSON.parse(JSON.stringify(DEFLAY.widgets.find(d => d.id === id) || {}));
      if (!w.id) return;
      LAY.widgets.push(w);
    } else {
      const i = LAY.widgets.findIndex(w => w.id === id);
      LAY.removed.push(LAY.widgets.splice(i, 1)[0]);
    }
    save(); buildWidgets();
    toast(`${PAGES[id].title} ${on ? 'is back on the home page' : 'is hidden from the home page'}`);
    paintDock(); paintSwitch();
  }
  function paintSwitch() {
    if (!state.id || PAGES[state.id].page) return;
    const sw = root.querySelector('.pg-sw'), on = state.id && onHome(state.id);
    sw.setAttribute('aria-checked', String(!!on)); sw.classList.toggle('on', !!on);
    root.querySelector('.pg-tlab').textContent = on ? 'Shown on home' : 'Hidden from home';
  }
  root.querySelector('.pg-sw').addEventListener('click', e => { e.stopPropagation(); if (state.id) setHome(state.id, !onHome(state.id)); });
  /* the switch is movable; where you leave it is remembered */
  const tg = root.querySelector('.pg-toggle'), POSKEY = 'os-page-toggle-pos';
  const placeToggle = () => {
    let p = null; try { p = JSON.parse(copyStorage.getItem(POSKEY) || 'null'); } catch (_) {}
    const r = tg.getBoundingClientRect();
    const x = p ? Math.min(Math.max(8, p.x * innerWidth), innerWidth - r.width - 8) : null;
    const y = p ? Math.min(Math.max(8, p.y * innerHeight), innerHeight - r.height - 8) : null;
    tg.style.left = x == null ? '' : x + 'px'; tg.style.top = y == null ? '' : y + 'px';
    tg.style.right = x == null ? '' : 'auto'; tg.style.bottom = y == null ? '' : 'auto';
  };
  tg.addEventListener('pointerdown', e => {
    if (e.target.closest('.pg-sw')) return;
    e.preventDefault(); tg.setPointerCapture(e.pointerId); tg.classList.add('drag');
    const r = tg.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = ev => { tg.style.left = Math.min(Math.max(8, ev.clientX - dx), innerWidth - r.width - 8) + 'px';
      tg.style.top = Math.min(Math.max(8, ev.clientY - dy), innerHeight - r.height - 8) + 'px'; tg.style.right = tg.style.bottom = 'auto'; };
    const up = () => { tg.classList.remove('drag'); tg.removeEventListener('pointermove', mv); tg.removeEventListener('pointerup', up);
      const q = tg.getBoundingClientRect(); copyStorage.setItem(POSKEY, JSON.stringify({ x: q.left / innerWidth, y: q.top / innerHeight })); };
    tg.addEventListener('pointermove', mv); tg.addEventListener('pointerup', up);
  });
  addEventListener('resize', () => { if (!root.hidden) placeToggle(); });

  /* ---------- dock buttons ---------- */
  function paintDock() {
    document.querySelectorAll('.tbar .pgBtn').forEach(b => {
      const id = b.dataset.page, P = PAGES[id]; if (!P) return;
      const hid = !P.page && !onHome(id);   /* Needs you has no home spot, so it is never "hidden" */
      b.classList.toggle('on', id === state.id && !root.hidden);
      b.classList.toggle('hiddenw', hid);
      b.title = P.title + ' page' + (hid ? ' (hidden from home)' : '');
    });
  }
  document.addEventListener('click', e => {
    const b = e.target.closest?.('.tbar .pgBtn'); if (!b) return;
    e.stopPropagation();
    if (state.id === b.dataset.page && !root.hidden) close(); else open(b.dataset.page);
  });
  new MutationObserver(() => { const t = document.querySelector('.tbar'); if (t && !t.dataset.pg) { t.dataset.pg = 1; paintDock(); } })
    .observe(document.body, { childList: true });
  paintDock();

  /* ---------- open / close / refresh ---------- */
  let lastFocus = null;
  const pageIco = id => {
    if (PAGES[id] && PAGES[id].icon) { let h = ''; try { h = ico(PAGES[id].icon); } catch (_) {} if (h) return h; }
    if (id !== 'needs') return ico(id);
    let h = ''; try { h = ico('bell'); } catch (_) {}
    return h || ico('bolt');
  };
  function open(id) {
    if (!PAGES[id]) return;
    if (root.hidden) lastFocus = document.activeElement;
    state.id = id; state.filter = 'all'; state.q = '';
    const P = PAGES[id];
    root.querySelector('.pg-ic').innerHTML = pageIco(id);
    root.querySelector('h2').textContent = P.title;
    root.querySelector('.pg-tt p').textContent = P.sub;
    root.querySelector('.pg-toggle').hidden = !!P.page;
    root.hidden = false; requestAnimationFrame(() => root.classList.add('show'));
    document.body.classList.add('pageopen');
    placeToggle(); if (!P.page) paintSwitch(); paintDock();
    const cached = cachedFor(id);
    if (cached) render(cached); else body.innerHTML = '<div class="pg-load">Loading…</div>';
    refresh();
    state.sig = null;
    clearInterval(state.timer); state.timer = setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, 60000);
    root.querySelector('[data-act="close"]').focus({ preventScroll: true });
  }
  function close() {
    root.classList.remove('show'); document.body.classList.remove('pageopen');
    clearInterval(state.timer); state.id = null; paintDock();
    setTimeout(() => { if (!root.classList.contains('show')) root.hidden = true; }, 200);
    lastFocus?.focus?.({ preventScroll: true });
  }
  const cachedFor = id => id === 'w-learned' && LIVE_STATE.learned
    ? { ...LIVE_STATE.learned, receipts: LIVE_STATE.receipts }
    : ({ 'w-pulse': LIVE_STATE.pulse, 'w-voice': LIVE_STATE.voice })[id] || null;
  /* Needs you reads five feeds; one that fails becomes a notice in its own section, never a broken page */
  async function loadNeeds() {
    const keys = ['learned', 'voice', 'email', 'pulse', 'routines'];
    const paths = { learned: '/api/learned', voice: '/api/voice', email: '/api/email', pulse: '/api/pulse', routines: '/api/routines' };
    const res = await Promise.allSettled(keys.map(k => api(paths[k])));
    const out = {};
    res.forEach((x, i) => { out[keys[i]] = x.status === 'fulfilled' && x.value ? x.value : { error: (x.reason && x.reason.message) || 'could not load' }; });
    return out;
  }
  async function refresh({ quiet = false } = {}) {
    const id = state.id; if (!id) return;
    const btn = root.querySelector('[data-act="refresh"]'); btn.classList.add('spin');
    try {
      let d;
      if (id === 'needs') d = await loadNeeds();
      else if (LOADERS[id]) d = await LOADERS[id](api);
      else {
        d = await api(PAGES[id].feed);
        if (id === 'w-apps') { let h = {}; try { h = await api('/api/health'); } catch (_) {} d = { ...d, health: h.companions || {} }; }
        if (id === 'w-rt') { try { d.pulseFeed = await api('/api/pulse'); } catch (_) {} }
        if (id === 'w-learned') { try { d.receipts = await api('/api/receipts'); } catch (_) {} }
      }
      if (state.id !== id) return;
      /* a timed refresh with nothing new leaves the Learned page alone, so its standings filters and open rows survive */
      const sig = id === 'w-learned' ? JSON.stringify(d, (k, v) => (k === 'fetched' ? undefined : v)) : null;
      if (!(quiet && sig && sig === state.sig)) { state.data = d; render(d); }
      state.sig = sig;
      root.querySelector('.pg-upd').textContent = 'updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch (err) {
      if (state.id === id && !state.data) body.innerHTML = `<div class="pg-load">Could not load ${E(PAGES[id].feed || id)}: ${E(err.message)}</div>`;
    } finally { btn.classList.remove('spin'); }
  }
  root.addEventListener('click', e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'close') close(); else if (a === 'refresh') refresh();
    if (e.target === root) close();
  });
  document.addEventListener('keydown', e => {
    if (root.hidden) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
  }, true);
  /* keep focus inside the page while it is open */
  root.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const f = [...root.querySelectorAll('button:not([disabled]), a[href], input')].filter(x => x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  /* ---------- pages from other files (2026-11-01) ----------
     hqPages.register(id, { title, sub, icon, feed | load(api), render(d, kit) }) adds a page with no widget
     behind it (like Needs you); its dock button is any `.tbar .pgBtn[data-page=id]`. kit hands over the
     building blocks below: { body, E, kpi, kpis, card, grid, chip, ago, stamp, hmt, post, api, toast, refresh }. */
  const EXTRA = {}, LOADERS = {};
  function register(id, def) {
    if (!id || !def || typeof def.render !== 'function' || (PAGES[id] && !EXTRA[id])) return false;
    PAGES[id] = { title: def.title || id, sub: def.sub || '', feed: def.feed || null, icon: def.icon || '', page: true };
    EXTRA[id] = def.render;
    if (typeof def.load === 'function') LOADERS[id] = def.load; else delete LOADERS[id];
    paintDock();
    return true;
  }
  const kit = () => ({ body, E, kpi, kpis, card, grid, chip, ago, stamp, hmt, post, api, toast, refresh });
  window.hqPages = { open, close, refresh, setHome, onHome, state, register };

  /* ---------- building blocks ---------- */
  const kpi = (label, value, sub = '', tone = '') => `<div class="pg-kpi ${tone}${String(value).length > 9 ? ' long' : ''}"><b title="${E(value)}">${E(value)}</b><span>${E(label)}</span>${sub ? `<small>${E(sub)}</small>` : ''}</div>`;
  const kpis = list => `<div class="pg-kpis">${list.join('')}</div>`;
  const card = (title, html, opts = {}) => `<section class="pg-card ${opts.cls || ''}" style="${opts.span ? `grid-column:span ${opts.span};` : ''}">
    <h3><span>${E(title)}</span>${opts.side ? `<em>${opts.side}</em>` : ''}</h3>${opts.hint ? `<p class="pg-hint">${opts.hint}</p>` : ''}${html}</section>`;
  const grid = (...cards) => `<div class="pg-grid">${cards.join('')}</div>`;
  const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
  const ago = v => { const t = typeof v === 'number' ? v : Date.parse(v || ''); if (!Number.isFinite(t)) return 'never';
    const m = Math.round((Date.now() - t) / 6e4); if (m < 0) return 'in ' + until(t);
    return m < 2 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
  const until = t => { const m = Math.max(0, Math.round((t - Date.now()) / 6e4)); return m < 60 ? m + ' min' : m < 1440 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : Math.round(m / 1440) + ' d'; };
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hm = (h, m) => { const d = new Date(2000, 0, 1, +h, +m); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
  /* human-facing clock time: 12-hour via HQTime.hm ("21:42" -> "9:42 PM"), local helper if HQTime is absent */
  const hmt = t => { const T = window.HQTime; if (T && typeof T.hm === 'function') { const s = T.hm(t); if (s != null) return s; }
    const p = String(t == null ? '' : t).split(':'); if (!/^\d{1,2}$/.test(p[0]) || !/^\d{1,2}$/.test(p[1])) return String(t == null ? '' : t);
    return hm(p[0], p[1]); };
  /* human-facing date + time: HQTime.dateTime when present, otherwise a plain "Oct 29, 4:54 AM" */
  const stamp = v => { const T = window.HQTime;
    if (T && typeof T.dateTime === 'function') { try { const s = T.dateTime(v); if (s) return s; } catch (_) {} }
    const t = typeof v === 'number' ? v : Date.parse(v || '');
    return Number.isFinite(t) ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; };
  function cronText(c) {
    if (!c) return 'on demand';
    const p = String(c).replace(/^cron\s+/, '').trim().split(/\s+/);
    if (p.length !== 5 || /[^\d,*\-/]/.test(p[0] + p[1])) return c;
    const [mi, hr, dom, mon, dw] = p;
    const times = hr === '*' ? 'every hour' : hr.split(',').map(h => hm(h, mi === '*' ? 0 : mi)).join(' & ');
    let days = 'daily';
    if (dw !== '*') days = dw === '1-5' ? 'weekdays' : dw === '0,6' || dw === '6,0' ? 'weekends' : dw.split(',').map(x => DOW[+x % 7] || x).join(', ');
    if (dom !== '*' || mon !== '*') days = `day ${dom}${mon !== '*' ? ' of month ' + mon : ''}`;
    return `${days} · ${times}`;
  }
  const strip = (dots, days) => `<span class="pg-strip">${dots.map((s, j) => `<i class="pd ${E(s)}" title="${E((days && days[j] ? new Date(days[j] + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ': ' : '') + (PULSE_WORD[s] || s))}"></i>`).join('')}</span>`;
  const KIND = { desktop: ['Claude desktop', 'v'], deck: ['Deck card', 'b'], windows: ['Windows task', 'c'] };
  const chip = (t, tone = '', title = '') => `<span class="pg-chip ${tone}"${title ? ` title="${E(title)}"` : ''}>${E(t)}</span>`;
  const bar = (parts) => `<span class="pg-bar">${parts.filter(p => p.v > 0).map(p => `<i class="${p.c}" style="flex:${p.v}" title="${E(p.t)}"></i>`).join('') || '<i class="none" style="flex:1"></i>'}</span>`;
  const post = (path, json) => fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) }).then(r => r.json());
  const filters = (list) => `<div class="pg-filters" role="toolbar">${list.map(([k, t, n]) => `<button type="button" class="pg-f${state.filter === k ? ' on' : ''}" data-f="${k}">${E(t)}${n != null ? ` <b>${n}</b>` : ''}</button>`).join('')}
    <label class="pg-search">${ico('search')}<input type="search" placeholder="Filter by name" value="${E(state.q)}" aria-label="Filter by name"></label></div>`;
  function wireFilters(rerender) {
    body.querySelectorAll('.pg-f').forEach(b => b.onclick = () => { state.filter = b.dataset.f; rerender(); });
    const i = body.querySelector('.pg-search input');
    if (i) i.oninput = () => { state.q = i.value; const pos = i.selectionStart; rerender(); const j = body.querySelector('.pg-search input'); j.focus(); j.setSelectionRange(pos, pos); };
  }
  const armed = (btn, label, go) => {
    if (!btn.classList.contains('arm')) { btn.classList.add('arm'); const was = btn.textContent; btn.textContent = label;
      setTimeout(() => { if (btn.isConnected && !btn.disabled) { btn.classList.remove('arm'); btn.textContent = was; } }, 3000); return; }
    btn.disabled = true; go();
  };

  function render(d) {
    const fn = { 'w-pulse': pulsePage, 'w-learned': learnedPage, 'w-apps': appsPage, 'w-sk': skillsPage, 'w-rt': routinesPage, 'w-voice': voicePage, 'needs': needsPage }[state.id]
      || (EXTRA[state.id] && (x => EXTRA[state.id](x, kit())));
    if (!fn || !d) return;
    const st = body.scrollTop;
    try { fn(d); } catch (err) { body.innerHTML = `<div class="pg-load">This page hit an error: ${E(err.message)}</div>`; console.error(err); }
    body.scrollTop = st;
  }

  /* ================= AUTOMATION PULSE ================= */
  function pulsePage(d) {
    const rows = d.rows || [], days = d.days || [], last = r => r.dots[r.dots.length - 1];
    const okToday = rows.filter(r => last(r) === 'ok').length, probs = rows.filter(r => ['fail', 'miss'].includes(last(r)));
    const all = rows.flatMap(r => r.dots), runs = all.filter(s => s === 'ok').length, fails = all.filter(s => s === 'fail').length, miss = all.filter(s => s === 'miss').length;
    const u = rows.reduce((a, r) => { const x = r.useful; if (x) { a.k += x.kept; a.t += x.total; a.o += x.opened; a.tr += x.trashed; } return a; }, { k: 0, t: 0, o: 0, tr: 0 });
    const noisy = rows.filter(r => r.noisy).length;
    /* per-day stacked columns */
    const perDay = days.map((day, j) => ({ day, ok: rows.filter(r => r.dots[j] === 'ok').length, fail: rows.filter(r => r.dots[j] === 'fail').length, miss: rows.filter(r => r.dots[j] === 'miss').length }));
    const mx = Math.max(1, ...perDay.map(p => p.ok + p.fail + p.miss));
    const cols = `<div class="pg-cols">${perDay.map(p => `<div class="pg-col" title="${E(new Date(p.day + 'T12:00:00').toDateString())}: ${p.ok} ran, ${p.fail} failed, ${p.miss} missed">
        <div class="stack" style="height:${Math.round(100 * (p.ok + p.fail + p.miss) / mx)}%">${p.miss ? `<i class="miss" style="flex:${p.miss}"></i>` : ''}${p.fail ? `<i class="fail" style="flex:${p.fail}"></i>` : ''}${p.ok ? `<i class="ok" style="flex:${p.ok}"></i>` : ''}</div>
        <b>${p.ok + p.fail + p.miss}</b><span>${new Date(p.day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</span></div>`).join('')}</div>`;
    const kinds = ['desktop', 'deck', 'windows'];
    const byKind = `<div class="pg-split">${kinds.map(k => { const rs = rows.filter(r => r.kind === k); const ok = rs.filter(r => r.dots.includes('ok')).length;
      return `<div><b>${rs.length}</b><span>${E({ desktop: 'Claude desktop tasks', deck: 'Deck cards', windows: 'Windows tasks' }[k])}</span><small>${ok} ran this week</small></div>`; }).join('')}</div>`;
    const f = state.filter, q = state.q.toLowerCase();
    /* quiet: writes no reports and nothing failed; retired: the deck card is gone */
    const retiredOf = r => r.retired === true;
    const probOf = r => ['fail', 'miss'].includes(last(r)) || r.dots.includes('fail');
    const quietOf = r => { if (retiredOf(r)) return false; if (typeof r.quiet === 'boolean') return r.quiet;
      return r.useful == null && !r.dots.includes('fail') && !r.dots.includes('miss') && !(r.lastRun && r.lastRun.ok === false); };
    const rowOf = r => { const x = r.useful, k = KIND[r.kind] || [r.kind, ''];
      return `<div class="pg-tr${['fail', 'miss'].includes(last(r)) ? ' problem' : ''}">
          <span class="nm"><b>${E(r.name)}</b>${chip(k[0], k[1])}${r.noisy ? chip('noisy?', 'a') : ''}${retiredOf(r) && r.retiredInto ? `<small class="mut">→ ${E(r.retiredInto)}</small>` : ''}</span>
          <span class="mut">${E(cronText(r.cron))}</span>
          <span class="c">${strip(r.dots, days)}</span>
          <span class="${r.lastRun && !r.lastRun.ok ? 'bad' : 'mut'}">${r.lastRun ? E(ago(r.lastRun.at)) + (r.lastRun.ok ? '' : ' · failed') : 'no runs yet'}</span>
          <span>${x ? `${bar([{ v: x.kept, c: 'ok', t: x.kept + ' kept' }, { v: Math.max(0, x.opened - x.kept), c: 'b', t: x.opened + ' opened' }, { v: x.trashed, c: 'fail', t: x.trashed + ' trashed' }, { v: Math.max(0, x.total - Math.max(x.opened, x.kept) - x.trashed), c: 'none', t: 'unread' }])}<small>${x.kept}/${x.total} kept</small>` : '<small class="mut">writes no reports</small>'}</span>
          <span>${r.open ? `<button type="button" class="pg-mini" data-open="${E(r.open)}">Open</button>` : ''}</span></div>`; };
    const groupOf = (key, label, list, note) => `<div class="pg-tr grp${openGroups[key] ? ' open' : ''}" data-grp="${key}" role="button" tabindex="0" aria-expanded="${!!openGroups[key]}">
        <span class="grp-n"><b>${E(label)} (${list.length})</b>${note ? ': ' + E(note) : ''}</span></div>`;
    const searched = rows.filter(r => !q || r.name.toLowerCase().includes(q));
    let shown;
    /* groups only on the unfiltered All view; filters and a name search stay flat */
    if (f === 'all' && !q) {
      const probs = searched.filter(probOf), rest = searched.filter(r => !probOf(r));
      const active = rest.filter(r => !quietOf(r) && !retiredOf(r));
      const quiet = rest.filter(quietOf), retired = rest.filter(r => retiredOf(r) && !quietOf(r));
      const block = [];
      if (probs.length) block.push(probs.map(rowOf).join(''));
      if (active.length) block.push(active.map(rowOf).join(''));
      if (quiet.length) block.push(groupOf('quiet', 'Quiet automations', quiet, 'ran fine, write no reports') + (openGroups.quiet ? quiet.map(rowOf).join('') : ''));
      if (retired.length) block.push(groupOf('retired', 'Retired cards', retired) + (openGroups.retired ? retired.map(rowOf).join('') : ''));
      shown = block.join('') || '<div class="pg-empty">Nothing matches.</div>';
    } else shown = searched.filter(r => (f === 'all' ? true : f === 'prob' ? probOf(r) : r.kind === f)).map(rowOf).join('') || '<div class="pg-empty">Nothing matches.</div>';
    const table = `<div class="pg-table pulse"><div class="pg-tr th"><span>Automation</span><span>Schedule</span><span class="c">Last 7 days</span><span>Last run</span><span>Reports (14 d)</span><span></span></div>
      ${shown}</div>`;
    body.innerHTML = kpis([
      kpi('automations', rows.length, `${kinds.map(k => rows.filter(r => r.kind === k).length).join(' / ')} desktop / deck / windows`),
      kpi('ran OK today', okToday, `${pct(okToday, rows.length)}% of all`, 'g'),
      kpi('need a look today', probs.length, probs.slice(0, 2).map(r => r.name).join(', ') || 'all clear', probs.length ? 'r' : ''),
      kpi('runs in 7 days', runs, `${fails} failed · ${miss} missed`),
      kpi('reports kept', u.t ? pct(u.k, u.t) + '%' : '—', `${u.k} of ${u.t} in ${d.keptDays || 14} days`, u.t && pct(u.k, u.t) < 34 ? 'a' : 'b'),
      kpi('noisy candidates', noisy, 'last 5 reports all trashed', noisy ? 'a' : ''),
      kpi('quiet', rows.filter(quietOf).length, 'ran fine, write no reports')
    ]) + grid(
      card('Runs per day', cols, { span: 2, hint: 'Green ran fine, red failed, grey was due and never ran.' }),
      card('By kind', byKind, { hint: 'Claude desktop tasks, Skills Deck cards and Windows scheduled tasks.' })
    ) + card('Every automation', filters([['all', 'All', rows.length], ['prob', 'Problems', rows.filter(r => ['fail', 'miss'].includes(last(r)) || r.dots.includes('fail')).length],
        ['desktop', 'Claude desktop'], ['deck', 'Deck cards'], ['windows', 'Windows tasks']]) + table,
      { side: `history since ${E(new Date(d.historySince || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}`, cls: 'wide' })
      + card('How to read this', `<ul class="pg-list plain"><li><i class="pd ok"></i> ran fine that day · <i class="pd fail"></i> failed · <i class="pd miss"></i> was due but never ran · <i class="pd none"></i> not scheduled that day.</li>
        <li><b>Reports kept</b> counts the HTML reports an automation wrote in the last ${d.keptDays || 14} days that you opened and kept, versus trashed or never opened. A low number means the automation may not be worth its cost.</li>
        <li><b>Noisy?</b> marks an automation whose last five reports were all trashed: a candidate to cut or retune.</li></ul>`, { cls: 'wide' });
    const again = () => { const st = body.scrollTop; pulsePage(d); body.scrollTop = st; };
    wireFilters(again);
    body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => window.open(API + b.dataset.open, '_blank'));
    body.querySelectorAll('[data-grp]').forEach(g => {
      const flip = () => { openGroups[g.dataset.grp] = !openGroups[g.dataset.grp]; again(); };
      g.onclick = flip;
      g.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
    });
  }

  /* ================= WHAT HQ LEARNED ================= */
  /* one copy of the pending-proposal list and its Approve / Trash wiring: shared by What HQ Learned and Needs you */
  function pendingBox(pending, nextAt) {
    if (!pending.length) return `<div class="pg-empty">Nothing waiting. Next proposals ${nextAt ? E(nextAt.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' })) + ' (in ' + E(until(+nextAt)) + ')' : 'are not scheduled'}.</div>`;
    return `<div class="pg-list">${pending.map(p => { const a = p.assessment || {}, effortTone = a.effort === 'approve' ? 'g' : a.effort === 'large' ? 'v' : 'a', skills = p.skills && p.skills.length ? p.skills : [p.skill]; return `<div class="pg-li prop" data-id="${E(p.id)}" data-sid="${E(p.standingsId || '')}" data-ids="${E((p.ids || [p.id]).join(','))}" data-skills="${E(skills.join(','))}"><b>${E(p.text)}</b>
      <small class="prop-why">${E(a.why || '')}${a.by === 'auto' ? ' <em>est.</em>' : ''}</small>
      <span class="prop-assess">${chip(a.timeLabel || '', 'c', a.timeReason || '')}${chip(a.effortLabel || '', effortTone, a.effortReason || '')}</span>
      <span>${skills.map(s => chip('/' + s, 'v')).join('')}${p.topic ? chip('lessons/' + p.topic) : ''}${p.recurrence > 1 ? chip('seen ' + p.recurrence + 'x', 'a') : ''}
      <button type="button" class="pg-mini ok" data-act2="apply">Approve</button><button type="button" class="pg-mini no" data-act2="dismiss">Trash</button></span></div>`; }).join('')}</div>`;
  }
  function wirePending() {
    body.querySelectorAll('[data-act2]').forEach(b => b.onclick = () => armed(b, 'Sure?', () => {
      const el = b.closest('.prop'), apply = b.dataset.act2 === 'apply', skills = (el.dataset.skills || '').split(',').filter(Boolean);
      /* one entry per lesson: through its standing, Approve and Trash cover every skill still waiting on it */
      (el.dataset.sid ? post('/api/learned/status', { id: el.dataset.sid, status: apply ? 'done' : 'trashed' })
        : post('/api/gotchas/' + b.dataset.act2, { ids: (el.dataset.ids || el.dataset.id).split(',') })).then(x => {
        if (x.error) { toast(x.error); b.disabled = false; return; }
        const names = ((apply ? x.applied : x.dismissed) || []).map(a => a.skill).filter(Boolean), sk = names.length ? names : skills;
        toast(apply ? 'Gotcha added to ' + sk.map(s => '/' + s).join(', ') : 'proposal trashed' + (sk.length > 1 ? ' for ' + sk.length + ' skills' : ''));
        if (typeof pullLearned === 'function') pullLearned(); refresh();
      }).catch(() => { toast('server unreachable'); b.disabled = false; });
    }));
  }
  let learnedStandings = null;
  function wireStandings(root) {
    const H = window.HQStandings;
    const options = { labels: { done: 'Applied', trashed: 'Dismissed' }, topOpen: 10, emptyText: 'No lessons in these standings yet.', detail: H.detail,
      actions: item => item.status === 'open' ? [{ status: 'done', label: 'Apply', confirm: true }, { status: 'trashed', label: 'Dismiss', confirm: true }]
        : item.status === 'trashed' ? [{ status: 'open', label: 'Reopen' }] : [] };
    const board = H.controller({ api, post, toast, paint: (view, active) => {
      H.paint(root, H.html(view, { ...options, status: active.status, query: active.query }) +
        (view.items.length < view.total ? `<button type="button" class="pg-mini" data-learned-more>Show more (${view.items.length} of ${view.total})</button>` : ''));
    } });
    H.wire(root, {
      onAction: (id, status) => board.act(id, status),
      onFilter: next => board.load(next),
      onMore: () => board.load(board.state, true)
    });
    learnedStandings = { root, board };
    board.load({ status: 'ranked', query: '' });
  }
  function learnedPage(d) {
    const kept = learnedStandings && learnedStandings.root.contains(document.activeElement) ? document.activeElement : null;
    const keptCaret = kept && typeof kept.selectionStart === 'number' ? [kept.selectionStart, kept.selectionEnd] : null;
    if (d.error) { body.innerHTML = `<div class="pg-load">${E(d.error)}</div>`; return; }
    const wk = d.week || {}, ap = d.approved || {}, pending = d.pending || [], nx = d.nextProposals;
    const nextAt = nx ? new Date(`${nx.day}T${nx.time}:00`) : null;
    const reviewed = (ap.allTime || 0) + (ap.dismissed || 0);
    const receipts = d.receipts && d.receipts.week ? d.receipts : null;
    const receiptLine = receipts ? `This week: ${receipts.week.approved || 0} ${(receipts.week.approved || 0) === 1 ? 'fix' : 'fixes'} approved, ${receipts.week.recurred || 0} came back, ${receipts.week.runs || 0} ${(receipts.week.runs || 0) === 1 ? 'run' : 'runs'}, ${receipts.week.failed || 0} failed` : '';
    const receiptRows = receipts ? `<div class="pg-list">${(receipts.items || []).map((item, i) => `<div class="pg-li"><b>${E(item.text)}</b><span>${chip(item.tone || 'good', item.tone === 'bad' ? 'r' : item.tone === 'warn' ? 'a' : 'g')}${item.target === 'automations' || item.target === 'radar' ? `<button type="button" class="pg-mini" data-receipt="${i}">Open</button>` : ''}</span></div>`).join('') || '<div class="pg-empty">No follow-ups waiting.</div>'}</div>` : '';
    body.innerHTML = kpis([
      kpi('lessons added this week', '+' + (wk.added || 0), `${wk.runs || 0} lesson runs`, 'g'),
      kpi('lessons updated', wk.updated || 0, 'rewritten with newer facts'),
      kpi('superseded', wk.superseded || 0, 'replaced by a better lesson'),
      kpi('lessons on file', wk.total ?? '—', `${(wk.filesTouched || []).length} topic files touched`),
      kpi('open in standings', d.openTotal ?? pending.length, pending.length ? 'ranked strongest first' : 'all caught up', pending.length ? 'a' : 'g'),
      kpi('folded into skills', ap.allTime || 0, `${ap.thisWeek || 0} this week · ${ap.dismissed || 0} trashed`, 'b')
    ]) + (receipts ? card('Receipts', `<p class="pg-hint">${E(receiptLine)}</p>${receiptRows}`, { span: 3 }) : '') + grid(
      card('Newest lessons', `<div class="pg-list">${(d.newest || []).map(l => `<div class="pg-li"><b>${E(l.title)}</b><span>${chip(l.topic, 'b')}${l.verified ? ` verified ${E(l.verified)}` : ''}</span></div>`).join('') || '<div class="pg-empty">No lessons this week yet.</div>'}</div>`, { span: 2 }),
      card('Approval record', `<div class="pg-ring" style="--p:${pct(ap.allTime || 0, reviewed)}"><b>${pct(ap.allTime || 0, reviewed)}%</b><span>approved</span></div>
        <p class="pg-hint center">${ap.allTime || 0} approved · ${ap.dismissed || 0} trashed of ${reviewed} proposals</p>`),
      card('Standings', `<div id="learned-standings">${pendingBox(pending, nextAt)}</div>`,
        { span: 3, hint: 'Apply adds the Gotcha to that skill\'s SKILL.md; the list keeps every lesson ever proposed, re-ranked each evening.' }),
      card('Schedule', `<div class="pg-facts"><div><span>Last proposal run</span><b>${E(ago(d.lastProposalRun))}</b></div>
        <div><span>Next proposal run</span><b>${nextAt ? E(nextAt.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })) : '—'}</b></div>
        <div><span>Repeats</span><b>${E(nx ? cronText(nx.cron) : '—')}</b></div></div>`),
      card('Topic files touched this week', `<div class="pg-chips">${(wk.filesTouched || []).map(f => chip(f)).join('') || '<span class="pg-empty">none</span>'}</div>`, { span: 3 }),
      card('How the learning loop works', `<ol class="pg-steps"><li><b>Agents work.</b> Claude, Codex and the routines run tasks and hit snags.</li>
        <li><b>Lessons get written.</b> The Session lessons routine reads the session logs (secrets removed) and writes short lessons into topic files.</li>
        <li><b>Standings update.</b> Every evening, all lessons and unresolved registry rows are weighed together; incumbents keep their places until clearly beaten.</li>
        <li><b>The judge goes deeper.</b> It checks source evidence and the target skill, scores five criteria, challenges the top ten, and re-ranks the board.</li>
        <li><b>You decide.</b> Apply writes the Gotcha into its skill; dismiss keeps the lesson in permanent history.</li></ol>`, { span: 3 })
    );
    wirePending();
    const standingsRoot = body.querySelector('#learned-standings');
    if (standingsRoot && window.HQStandings) {
      if (!learnedStandings) wireStandings(standingsRoot);
      else {
        standingsRoot.replaceWith(learnedStandings.root);
        if (kept) { kept.focus({ preventScroll: true }); if (keptCaret) try { kept.setSelectionRange(keptCaret[0], keptCaret[1]); } catch (_) {} }
        learnedStandings.board.refresh();
      }
    }
    body.querySelectorAll('[data-receipt]').forEach(button => button.onclick = () => {
      const item = receipts && receipts.items && receipts.items[+button.dataset.receipt]; if (!item) return;
      if (item.target === 'automations') open('w-pulse');
      if (item.target === 'radar') location.href = '/radar.html';
    });
  }

  /* ================= MICRO APPS ================= */
  function appsPage(d) {
    const apps = d.apps || [], h = d.health || {}, live = apps.filter(a => a.live).length;
    const comps = (typeof COMPANIONS !== 'undefined' ? COMPANIONS : []);
    const up = comps.filter(c => h[c[0]] === true).length;
    const ports = { karakeep: 50110, changedetection: 50111, ntfy: 50112, promptfoo: 50113, qmd: 50114, basicMemory: 50115 };
    body.innerHTML = kpis([
      kpi('apps', apps.length, 'on the Micro Apps list'),
      kpi('running now', live, apps.filter(a => !a.live).map(a => a.name).join(', ') ? 'off: ' + apps.filter(a => !a.live).map(a => a.name).join(', ') : 'everything is up', 'g'),
      kpi('companions up', `${up}/${comps.length}`, comps.filter(c => h[c[0]] === false).map(c => c[1]).join(', ') ? 'down: ' + comps.filter(c => h[c[0]] === false).map(c => c[1]).join(', ') : 'all healthy', up < comps.length ? 'a' : 'g')
    ]) + card('Apps', `<div class="pg-apps">${apps.map(a => { const [ic, tint] = (APP_ICON[a.id] || [a.icon || 'box', '']);
        return `<button type="button" class="pg-app" data-app="${E(a.id)}"><span class="appic ${tint}">${ico(ic)}</span>
          <b>${E(a.name)}</b><small>${E(a.desc || '')}</small>
          <span class="pg-state ${a.live ? 'g' : 'mut'}"><i></i>${a.live ? 'running' : a.builtIn ? 'opens its page' : 'not running'}</span></button>`; }).join('')}
        <button type="button" class="pg-app add" data-addapp="1"><span class="appic add">${ico('plus')}</span><b>Add an app</b><small>Copies a prompt for your agent</small></button></div>`,
      { cls: 'wide', hint: 'Click a tile to open the app. "Running" means HQ reached it in the last minute.' })
      + card('Companion services', `<div class="pg-table comps"><div class="pg-tr th"><span>Service</span><span>What it does</span><span>Port</span><span>Status</span><span></span></div>
        ${comps.map(([k, label, , desc, opens]) => `<div class="pg-tr"><span class="nm"><b>${E(label)}</b></span><span class="mut">${E(desc)}</span><span class="mut">${ports[k] || '—'}</span>
          <span class="pg-state ${h[k] === true ? 'g' : h[k] === false ? 'r' : 'mut'}"><i></i>${h[k] === true ? 'up' : h[k] === false ? 'down' : 'unknown'}</span>
          <span>${opens ? `<button type="button" class="pg-mini" data-comp="${E(k)}">Open</button>` : ''}</span></div>`).join('')}</div>`,
        { cls: 'wide', hint: 'QMD and Basic Memory are MCP services for agents (no page to open). If one is down after a reboot, run start.cmd in your companions folder.' });
    body.querySelectorAll('[data-app]').forEach(b => b.onclick = () => openApp(b.dataset.app));
    body.querySelectorAll('[data-comp]').forEach(b => b.onclick = () => openApp(b.dataset.comp));
    body.querySelector('[data-addapp]').onclick = () => { $('appPrompt').value = ADD_APP_PROMPT; $('appop').classList.add('show'); };
  }

  /* ================= SKILLS DECK ================= */
  function skillsPage(d) {
    const skills = d.skills || [], runs = d.runs || [], M = d.models || MODELS, EF = d.efforts || EFFORTS;
    const by = id => runs.filter(r => r.id === id);
    const okRuns = runs.filter(r => r.exit === 0).length;
    const avg = xs => xs.length ? Math.round(xs.reduce((a, r) => a + (r.seconds || 0), 0) / xs.length) : 0;
    const today = runs.filter(r => new Date(r.at).toDateString() === new Date().toDateString()).length;
    const top = [...new Set(runs.map(r => r.id))].map(id => [id, by(id).length]).sort((a, b) => b[1] - a[1])[0];
    const secs = s => s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
    const agentOf = s => s.agent && s.agent !== 'claude' ? String(s.agent).toUpperCase() : 'CLAUDE';
    const cfgOf = s => { const c = (SKST.cfg || {})[s.id] || { model: s.model, effort: s.effort };
      return s.agent && s.agent !== 'claude' ? ((d.agentModels || {})[s.agent] || 'default model') : `${M[c.model] || '?'} · ${EF[c.effort] || '?'}`; };
    body.innerHTML = kpis([
      kpi('cards', skills.length, `${skills.filter(s => (s.agent || 'claude') === 'claude').length} Claude · ${skills.filter(s => s.agent && s.agent !== 'claude').length} other agents`),
      kpi('recent runs', runs.length, `${today} today`),
      kpi('succeeded', runs.length ? pct(okRuns, runs.length) + '%' : '—', `${runs.length - okRuns} failed`, runs.length - okRuns ? 'a' : 'g'),
      kpi('average run', runs.length ? secs(avg(runs)) : '—', 'wall-clock time'),
      kpi('most used', top ? '/' + top[0] : '—', top ? top[1] + ' recent runs' : '', 'b'),
      kpi('runner', d.runner || '—', 'from os-config.json', d.runner === 'ready' ? 'g' : 'r')
    ]) + card('Cards', `<div class="pg-skills">${skills.map(s => { const rs = by(s.id), lr = rs[0], ok = rs.filter(r => r.exit === 0).length;
        return `<div class="pg-skill" data-id="${E(s.id)}"><div class="top"><span class="appic v">${ico(s.icon)}</span><b>/${E(s.id)}</b>${chip(agentOf(s), s.agent && s.agent !== 'claude' ? 'c' : 'v')}</div>
          <div class="cfg">${E(cfgOf(s))}</div>
          <p title="${E(s.prompt)}">${E(String(s.prompt || '').replace(/\s+/g, ' ').slice(0, 220))}${String(s.prompt || '').length > 220 ? '…' : ''}</p>
          <div class="stats"><span><b>${rs.length}</b> runs</span><span><b>${rs.length ? pct(ok, rs.length) + '%' : '—'}</b> ok</span><span><b>${rs.length ? secs(avg(rs)) : '—'}</b> avg</span><span>${lr ? 'last ' + E(ago(lr.at)) : 'never run'}</span></div>
          <div class="acts">${lr && lr.report ? `<button type="button" class="pg-mini" data-rep="${E(lr.report)}">Latest report</button>` : ''}<button type="button" class="pg-mini go" data-run="${E(s.id)}">Run</button></div></div>`; }).join('')}</div>`,
      { cls: 'wide', hint: 'Run spends that agent\'s credit, so it asks twice. The model and effort are the ones set on the deck card.' })
      + card('Recent runs', `<div class="pg-table runs"><div class="pg-tr th"><span>When</span><span>Card</span><span>Agent · model · effort</span><span>Time</span><span>Result</span><span></span></div>
        ${runs.map(r => `<div class="pg-tr"><span class="mut">${E(new Date(r.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>
          <span class="nm"><b>/${E(r.id)}</b></span><span class="mut">${E([r.agent, r.model, r.effort].filter(Boolean).join(' · '))}</span><span class="mut">${secs(r.seconds || 0)}</span>
          <span class="pg-state ${r.exit === 0 ? 'g' : 'r'}"><i></i>${r.exit === 0 ? 'ok' : 'exit ' + E(r.exit)}</span>
          <span>${r.report ? `<button type="button" class="pg-mini" data-rep="${E(r.report)}">Report</button>` : ''}</span></div>`).join('') || '<div class="pg-empty">No runs recorded.</div>'}</div>`, { cls: 'wide' });
    body.querySelectorAll('[data-rep]').forEach(b => b.onclick = () => window.open(API + '/artifacts/' + encodeURIComponent(b.dataset.rep), '_blank'));
    body.querySelectorAll('[data-run]').forEach(b => b.onclick = () => armed(b, 'Sure? Run', () => {
      const id = b.dataset.run, deckCard = document.querySelector(`#deck .dk[data-id="${CSS.escape(id)}"]`);
      if (deckCard && typeof playSkill === 'function') { playSkill(deckCard, deckCard.querySelector('.abtn.play')); toast('/' + id + ' started - progress shows on its deck card'); }
      else {
        const s = skills.find(x => x.id === id), c = (SKST.cfg || {})[id] || { model: s.model, effort: s.effort };
        post('/api/run', { id, model: MODELS[c.model], effort: EFFORTS[c.effort] }).then(x => toast(x.job ? '/' + id + ' started' : x.error || 'run failed to start')).catch(() => toast('server unreachable'));
      }
      setTimeout(() => { b.disabled = false; b.classList.remove('arm'); b.textContent = 'Run'; }, 4000);
    }));
  }

  /* ================= ROUTINES ================= */
  function routinesPage(d) {
    const rows = d.routines || [], sw = d.switches || [], hb = d.heartbeat || {}, missed = d.missed || [];
    const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    const mins = t => { const [h, m] = String(t || '0:0').split(':'); return +h * 60 + +m; };
    const fired = rows.filter(r => mins(r.t) <= nowMin), next = rows.filter(r => mins(r.t) > nowMin).sort((a, b) => mins(a.t) - mins(b.t))[0];
    const nextAt = next ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), ...String(next.t).split(':').map(Number)) : null;
    const srcLabel = Object.fromEntries((d.sources || []).map(s => [s.key, s.label]));
    const models = d.models || {};
    const line = `<div class="pg-timeline"><div class="track">${[0, 6, 12, 18, 24].map(h => `<span class="tick" style="left:${h / 24 * 100}%"><em>${h === 24 ? '' : hm(h, 0).replace(':00', '')}</em></span>`).join('')}
        ${rows.map(r => `<i class="pt ${mins(r.t) <= nowMin ? 'done' : ''}" style="left:${mins(r.t) / 1440 * 100}%" title="${E(hmt(r.t) + ' · ' + r.n)}"></i>`).join('')}
        <span class="now" style="left:${nowMin / 1440 * 100}%"><em>now</em></span></div></div>`;
    const stripOf = p => p && p.strip ? strip(p.strip.map(x => x.status), p.strip.map(x => x.day)) : '';
    body.innerHTML = kpis([
      kpi("today's fires", rows.length, `${fired.length} done · ${rows.length - fired.length} to go`),
      kpi('next up', next ? hmt(next.t) : '—', next ? `${next.n} in ${until(+nextAt)}` : 'nothing else today', 'b'),
      kpi('background checks', `${hb.ok ?? '—'}/${hb.total ?? '—'}`, (hb.failing || []).map(f => f.summary).join(' · ') || 'all OK', hb.level === 'red' ? 'r' : hb.level === 'amber' ? 'a' : 'g'),
      kpi('switches on', `${sw.filter(s => s.on).length}/${sw.length}`, sw.filter(s => !s.on).map(s => s.name).join(', ') ? 'paused: ' + sw.filter(s => !s.on).map(s => s.name).join(', ') : 'none paused'),
      kpi('missed fires', missed.reduce((a, m) => a + (m.missed || 0), 0), missed.map(m => m.name).join(', ') || 'none', missed.length ? 'a' : 'g'),
      kpi('other automations', (d.pulseOthers || []).length, 'deck cards and Windows tasks: see Automation Pulse')
    ]) + card("Today's timeline", line, { cls: 'wide', hint: 'Each dot is one scheduled fire today. Filled dots have already fired.' })
      + card("Today's routines", `<div class="pg-table rts"><div class="pg-tr th"><span>Time</span><span>Routine</span><span>Source · model</span><span class="c">Last 7 days</span><span>Last run</span></div>
        ${rows.map(r => `<div class="pg-tr${mins(r.t) <= nowMin ? '' : ' later'}"><span class="time">${E(hmt(r.t))}</span>
          <span class="nm"><b>${E(r.n)}</b><small>${E(r.desc || '')}</small></span>
          <span class="mut">${E(srcLabel[r.src] || r.src || '')}${models[r.id] ? ' · ' + modelBadge(models[r.id]) : ''}</span>
          <span class="c">${stripOf(r.pulse)}</span>
          <span class="${r.pulse && r.pulse.lastRun && !r.pulse.lastRun.ok ? 'bad' : 'mut'}">${r.pulse && r.pulse.lastRun ? E(ago(r.pulse.lastRun.at)) : '—'}</span></div>`).join('') || '<div class="pg-empty">Nothing scheduled today.</div>'}</div>`, { cls: 'wide' })
      + card('All routine switches', `<div class="pg-table sws"><div class="pg-tr th"><span>Routine</span><span>Runs</span><span>Model</span><span class="c">Last 7 days</span><span>State</span><span></span></div>
        ${sw.map(s => `<div class="pg-tr"><span class="nm"><b>${E(s.name)}</b>${s.missed ? chip(s.missed + ' missed', 'a') : ''}</span>
          <span class="mut">${E(cronText(s.when))}</span><span>${s.model ? modelBadge(s.model) : ''}</span><span class="c">${stripOf(s.pulse)}</span>
          <span class="pg-state ${s.on ? 'g' : 'mut'}"><i></i>${s.on ? 'on' : 'paused'}</span>
          <span><button type="button" class="pg-mini" data-task="${E(s.task)}" data-on="${s.on ? 0 : 1}">${s.on ? 'Turn off' : 'Turn on'}</button></span></div>`).join('')}</div>`,
        { cls: 'wide', hint: 'Claude desktop routines can only be switched from a Claude desktop session, so the button copies a one-line prompt for Claude.' });
    body.querySelectorAll('[data-task]').forEach(b => b.onclick = () => {
      const on = b.dataset.on === '1', task = b.dataset.task;
      const prompt = `Turn ${on ? 'on' : 'off'} my scheduled routine "${task}": call update_scheduled_task with taskId "${task}" and enabled ${on}. Change nothing else, then confirm.`;
      navigator.clipboard.writeText(prompt).then(() => { const was = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = was; }, 1500); },
        () => window.prompt('Copy this prompt into Claude:', prompt));
    });
  }

  /* ================= NEEDS YOU (a page, not a widget) ================= */
  function needsPage(d) {
    const L = d.learned || {}, V = d.voice || {}, M = d.email || {}, P = d.pulse || {}, R = d.routines || {};
    const bad = x => !!(x && x.error);
    const notice = (x, what) => bad(x) ? `<div class="pg-empty">Could not load ${E(what)}: ${E(x.error)}</div>` : '';
    const pending = bad(L) ? [] : (L.pending || []);
    const qs = bad(V) ? [] : (V.questions || []), vOpen = bad(V) ? 0 : (V.openItemCount ?? (V.openInferred || []).length);
    const drafts = bad(M) ? [] : (M.drafts || []), flagged = bad(M) ? [] : (M.flagged || []);
    const missed = bad(R) ? [] : (R.missed || []), missedN = missed.reduce((a, m) => a + (m.missed || 0), 0);
    const lastDot = r => (r.dots || [])[r.dots.length - 1];
    const failing = bad(P) ? [] : (P.rows || []).filter(r => ['fail', 'miss'].includes(lastDot(r)));
    const calls = bad(V) ? 0 : (V.needsCallCount ?? qs.length);
    const emailN = drafts.length + flagged.length, routineN = missedN + failing.length;
    const calm = !bad(L) && !bad(V) && !bad(M) && !bad(P) && !bad(R) && !pending.length && !calls && !qs.length && !emailN && !routineN;
    const mailRows = drafts.map(m => `<div class="pg-li"><b>${E(m.subject)}</b><small class="prop-why">${E(m.why || '')}</small><span class="mut">drafted ${E(stamp(m.created))}</span></div>`).join('')
      + flagged.map(m => `<div class="pg-li mail" data-mail="${E(m.id)}" role="button" tabindex="0" title="Open this message in Gmail"><b>${E(m.subject)}</b><span class="mut">${E(m.from || '')} · ${E(ago(m.ts))}</span></div>`).join('');
    const rBits = [];
    if (bad(R)) rBits.push(notice(R, 'routines'));
    if (bad(P)) rBits.push(notice(P, 'pulse'));
    if (!bad(R)) rBits.push(missed.map(m => `<div class="pg-li"><b>${E(m.name)}</b><span>${chip((m.missed || 0) + ' missed', 'a')}</span></div>`).join(''));
    if (!bad(P)) rBits.push(failing.map(r => { const k = KIND[r.kind] || [r.kind, ''];
      return `<div class="pg-li"><b>${E(r.name)}</b><span>${chip(k[0], k[1])}${chip(lastDot(r), lastDot(r) === 'fail' ? 'r' : 'a')}${r.open ? `<button type="button" class="pg-mini" data-open="${E(r.open)}">Open</button>` : ''}</span></div>`; }).join(''));
    if (!bad(R) && !bad(P) && !missed.length && !failing.length) rBits.push('<div class="pg-empty">Every routine is on track.</div>');
    body.innerHTML = kpis([
      kpi('skill fixes', pending.length, pending.length ? 'approve or trash below' : 'all caught up', pending.length ? 'a' : 'g'),
      kpi('voice calls', calls, `${qs.length} questions · ${vOpen} open items`, calls ? 'a' : 'g'),
      kpi('email', emailN, `${drafts.length} drafts · ${flagged.length} flagged`, emailN ? 'b' : 'g'),
      kpi('routines', routineN, `${missedN} missed fires · ${failing.length} failing`, routineN ? 'r' : 'g')
    ]) + (calm ? '<div class="pg-empty calm">Nothing needs you right now.</div>' : grid(
      card('Skill fixes waiting', bad(L) ? notice(L, 'skill fixes') : pendingBox(pending, null),
        { span: 2, hint: 'Approving adds the lesson as a Gotcha in that skill\'s SKILL.md, so the agent stops repeating the mistake. Click twice to confirm.' }),
      card('Voice: needs your call', (bad(V) ? notice(V, 'voice') : `<div class="pg-list">${qs.map(x => `<div class="pg-li"><b>${E(x.text)}</b><span class="mut">session ${E(x.session)} · ${E(x.date)}</span></div>`).join('') || '<div class="pg-empty">No open questions.</div>'}</div>`)
        + `<div class="pg-foot"><button type="button" class="pg-mini go" data-needs="voice">Open Voice page</button></div>`,
        { side: `${vOpen} open items`, hint: 'Questions your voice sessions left open. Answer them in the next session.' }),
      card('Email', (bad(M) ? notice(M, 'email') : `<div class="pg-list">${mailRows || '<div class="pg-empty">No drafts or flagged mail.</div>'}</div>`)
        + `<div class="pg-foot"><button type="button" class="pg-mini go" data-needs="drafts">Open Gmail drafts</button></div>`,
        { span: 2, hint: 'Reply drafts the email-digest routine wrote, then the mail it flagged for you. Click a flagged mail to open it.' }),
      card('Routines', `<div class="pg-list">${rBits.join('')}</div>`,
        { hint: 'Fires that were due and never ran, and automations whose last run failed.' })
    ));
    wirePending();
    const vBtn = body.querySelector('[data-needs="voice"]'); if (vBtn) vBtn.onclick = () => open('w-voice');
    const dBtn = body.querySelector('[data-needs="drafts"]');
    if (dBtn) dBtn.onclick = () => window.open('https://mail.google.com/mail/u/0/#drafts', '_blank');
    body.querySelectorAll('[data-mail]').forEach(el => {
      const go = () => window.open('https://mail.google.com/mail/u/0/#inbox/' + encodeURIComponent(el.dataset.mail), '_blank');
      el.onclick = go;
      el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
    body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => window.open(API + b.dataset.open, '_blank'));
  }

  /* ================= VOICE ================= */
  function voicePage(d) {
    if (!d.available) { body.innerHTML = '<div class="pg-load">No voice sessions yet.</div>'; return; }
    const q = d.queue || [], built = d.built || [], qs = d.questions || [], open = d.openInferred || [], dec = d.decisions || [];
    const STC = { drafted: 'a', building: 'b', done: 'g', blocked: 'r' };
    body.innerHTML = kpis([
      kpi('last session', new Date(`${d.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), ago(d.lastAt)),
      kpi('needs your call', d.needsCallCount || 0, `${qs.length} questions · ${open.length} open items`, d.needsCallCount ? 'a' : 'g'),
      kpi('in the build queue', q.length, d.queueHead ? d.queueHead.name : 'queue clear', 'b'),
      kpi('built since last talk', built.length, built[0] ? 'latest: ' + built[0].name : '', 'g'),
      kpi('decisions', dec.length, 'from the last session'),
      kpi('open items', d.openItemCount ?? open.length, 'ideas and action items not done yet')
    ]) + (d.building && d.building.name ? card('Building now', `<div class="pg-now"><i></i><b>${E(d.building.name)}</b>${chip(String(d.building.agent || 'agent').toUpperCase(), 'b')}${d.building.runningMs != null ? `<span class="mut">for ${Math.max(1, Math.round(d.building.runningMs / 60000))} min</span>` : ''}</div>`, { cls: 'wide' }) : '')
      + grid(
        card('Questions for you', `<div class="pg-list">${qs.map(x => `<div class="pg-li"><b>${E(x.text)}</b><span class="mut">session ${E(x.session)} · ${E(x.date)}</span></div>`).join('') || '<div class="pg-empty">No open questions.</div>'}</div>`, { span: 2 }),
        card('Decisions made', `<ul class="pg-list plain">${dec.map(x => `<li>${E(x)}</li>`).join('') || '<li class="pg-empty">none recorded</li>'}</ul>`),
        card('Open items', `<div class="pg-list">${open.map(x => `<div class="pg-li"><b>${E(x.text)}</b><span>${x.inferred ? chip('inferred', 'a') : ''}${chip(x.status || 'open')}<span class="mut"> session ${E(x.session)}</span></span></div>`).join('') || '<div class="pg-empty">Nothing open.</div>'}</div>`, { span: 2 }),
        card('Build queue', `<div class="pg-list">${q.map(x => `<div class="pg-li"><b>${E(x.name)}</b><span>${chip(x.status, STC[x.status] || '')}${x.agent ? chip(String(x.agent).toUpperCase(), 'b') : ''}</span></div>`).join('') || '<div class="pg-empty">Queue clear.</div>'}</div>`),
        card('Built since last talk', `<div class="pg-table built"><div class="pg-tr th"><span>Spec</span><span>Commit</span><span>When</span><span></span></div>
          ${built.map(x => `<div class="pg-tr"><span class="nm"><b>${E(x.name)}</b></span><span>${chip(String(x.commit || '').slice(0, 7), 'g')}</span><span class="mut">${E(ago(x.at))}</span>
            <span>${x.reportUrl ? `<a class="pg-mini" href="${E(x.reportUrl)}" target="_blank" rel="noopener noreferrer">Report</a>` : ''}</span></div>`).join('') || '<div class="pg-empty">Nothing built yet.</div>'}</div>`, { span: 3 })
      ) + `<div class="pg-foot"><button type="button" class="pg-mini go" data-note="1">Open the voice note</button></div>`;
    body.querySelector('[data-note]').onclick = () => post('/api/open', { path: d.notePath }).then(x => { if (x.error) toast(x.error); }).catch(() => toast('could not open the voice note'));
  }
})();
