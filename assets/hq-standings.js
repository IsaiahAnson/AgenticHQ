(function (factory) {
  const api = factory();
  if (typeof window !== 'undefined') window.HQStandings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(function () {
  const labelsDefault = { open: 'Open', approved: 'Approved', done: 'Done', trashed: 'Trashed' };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const date = value => {
    const d = new Date(value);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const time = value => {
    const d = new Date(value);
    if (isNaN(d)) return '';
    const helper = typeof window !== 'undefined' && window.HQTime;
    return helper ? helper.time(d) : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
  function movement(item) {
    if (item.rank === null) return { cls: '', text: '', title: '' };
    if (item.movement === 'new') return { cls: 'hs-mv-new', text: 'NEW', title: 'New this run' };
    if (item.movement === 'up') return { cls: 'hs-mv-up', text: '▲' + item.delta, title: 'Up ' + item.delta + ' since last run' };
    if (item.movement === 'down') return { cls: 'hs-mv-down', text: '▼' + (-item.delta), title: 'Down ' + (-item.delta) + ' since last run' };
    if (item.movement === 'same') return { cls: 'hs-mv-same', text: '–', title: 'Same spot as last run' };
    if (item.movement === 'returned') return { cls: 'hs-mv-back', text: '↺', title: 'Back in the standings' };
    return { cls: '', text: '', title: '' };
  }
  function defaultActions(item) {
    return item.status === 'open'
      ? [{ status: 'approved', label: 'Approve' }, { status: 'done', label: 'Done' }, { status: 'trashed', label: 'Trash', confirm: true }]
      : [{ status: 'open', label: 'Reopen' }];
  }
  function detail(item) {
    const j = (item.data || {}).judgment || {}, a = (item.data || {}).assessment || {}, scores = j.scores || {};
    const weights = { pain: 3, frequency: 2.5, specificity: 2, fit: 1.5, durability: 1 };
    const bars = Object.keys(weights).map(k => `<div class="hs-score"><span>${esc(k)} ×${weights[k]}</span><i style="--p:${Math.max(0, Math.min(10, +scores[k] || 0)) * 10}%"></i><b>${esc(scores[k] ?? '—')}</b></div>`).join('');
    const refs = (j.evidenceChecked || []).map(r => `<li>${esc(r)}</li>`).join('');
    // A lesson filed for several skills: where each one stands.
    const targets = (item.data || {}).targets || [], said = { proposed: 'waiting', applied: 'applied', rejected: 'dismissed' };
    const skills = targets.length > 1 ? `<p><b>Skills:</b> ${targets.map(t => `/${esc(t.skill)} ${esc(said[t.status] || t.status || 'waiting')}`).join(' · ')}</p>` : '';
    return `${skills}<div class="hs-rubric">${bars}</div>${j.critique ? `<p><b>Critique:</b> ${esc(j.critique)}</p>` : ''}
      ${a.why ? `<p><b>Assessment:</b> ${esc(a.why)}</p><p>${esc(a.timeLabel || '')} · ${esc(a.effortLabel || '')}</p>` : ''}
      ${refs ? `<p><b>Evidence checked</b></p><ul>${refs}</ul>` : ''}`;
  }
  function controller({ api, post, toast, paint }) {
    let active = { status: 'ranked', query: '' }, current = null, requestId = 0;
    const notify = typeof toast === 'function' ? toast : () => {};
    const repaint = typeof paint === 'function' ? paint : () => {};
    const state = () => ({ status: active.status, query: active.query, items: current ? current.items : [], total: current ? current.total : 0 });
    async function fetchPage(chosen, offset) {
      const params = new URLSearchParams({
        status: chosen.status || 'ranked',
        q: chosen.query || '',
        limit: '500',
        offset: String(offset)
      });
      const view = await api('/api/learned/standings?' + params);
      if (view && view.error) throw new Error(view.error);
      return view;
    }
    async function load(next = active, append = false) {
      const chosen = {
        status: next && next.status != null ? next.status : active.status,
        query: next && next.query != null ? next.query : active.query
      };
      const base = append && current ? current : null;
      const mine = ++requestId;
      try {
        const view = await fetchPage(chosen, base ? base.items.length : 0);
        if (mine !== requestId) return state();
        active = chosen;
        current = base ? { ...view, items: base.items.concat(view.items || []) } : view;
        repaint(current, state());
        return state();
      } catch (error) {
        if (mine === requestId) notify(error.message || 'Could not load standings');
        return state();
      }
    }
    async function refresh() {
      const wanted = current ? current.items.length : 0;
      const chosen = { ...active }, mine = ++requestId;
      try {
        let fresh = await fetchPage(chosen, 0);
        while (fresh.items.length < wanted && fresh.items.length < fresh.total) {
          const page = await fetchPage(chosen, fresh.items.length);
          if (!page.items || !page.items.length) break;
          fresh = { ...page, items: fresh.items.concat(page.items) };
        }
        if (mine !== requestId) return state();
        current = fresh;
        repaint(current, state());
      } catch (error) {
        if (mine === requestId) notify(error.message || 'Could not load standings');
      }
      return state();
    }
    async function act(id, status) {
      try {
        const result = await post('/api/learned/status', { id, status });
        if (result && result.error) { notify(result.error); return state(); }
        return refresh();
      } catch (error) {
        notify(error.message || 'Could not update standings');
        return state();
      }
    }
    return {
      load, refresh, act,
      get state() { return state(); },
      get status() { return active.status; },
      get query() { return active.query; },
      get items() { return current ? current.items : []; },
      get total() { return current ? current.total : 0; }
    };
  }
  function html(view, opts = {}) {
    const status = opts.status || 'ranked', query = opts.query || '';
    const labels = Object.assign({}, labelsDefault, opts.labels);
    const topOpen = opts.topOpen == null ? 10 : Math.max(0, Math.floor(opts.topOpen));
    const actions = opts.actions || defaultActions;
    const filters = [
      ['ranked', 'Ranked', view.counts.open], ['approved', labels.approved, view.counts.approved],
      ['done', labels.done, view.counts.done], ['trashed', labels.trashed, view.counts.trashed],
      ['all', 'All', view.counts.total]
    ];
    const run = view.runs[0];
    const runText = run ? 'Last run ' + time(run.at) + ' · ' + run.added + ' new · ' + run.merged + ' merged' : 'No runs yet';
    const filterHtml = filters.map(([id, label, count]) => {
      const on = status === id || (status === 'open' && id === 'ranked');
      return `<button type="button" data-status="${esc(id)}"${on ? ' class="on"' : ''} aria-pressed="${on}">${esc(label)} ${esc(count)}</button>`;
    }).join('');
    const tierHtml = status === 'ranked' ? `<div class="hs-tiers">${view.tiers.filter(t => t.count > 0).map(t =>
      `<span class="hs-tc hs-t-${esc(t.tier)}"><b>${esc(t.tier)}</b> ${esc(t.count)}</span>`).join('')}</div>` : '';
    function row(item) {
      const ranked = item.rank !== null, mv = movement(item);
      const rank = ranked ? `<span class="hs-rank">#${esc(item.rank)}</span><span class="hs-tier">${esc(item.tier)}</span>`
        : `<span class="hs-st hs-st-${esc(item.status)}">${esc(labels[item.status] || item.status)}</span>`;
      const meta = ['score ' + item.score];
      if (item.seenCount > 1) meta.push('seen ×' + item.seenCount);
      if (item.firstSeen) meta.push('since ' + date(item.firstSeen));
      if (item.category) meta.push(item.category);
      const buttons = actions(item).map(a => `<button type="button" class="hs-act" data-id="${esc(item.id)}" data-status="${esc(a.status)}"${a.confirm ? ' data-confirm="1"' : ''}>${esc(a.label)}</button>`).join('');
      const evidence = item.evidence.length ? `<ul class="hs-ev">${item.evidence.map(e => {
        const info = [e.source, e.at ? date(e.at) : ''].filter(Boolean).map(esc).join(' · ');
        return `<li>${esc(e.text)}${info ? ` <span>${info}</span>` : ''}</li>`;
      }).join('')}</ul>` : '';
      const detail = (item.summary ? `<p>${esc(item.summary)}</p>` : '') + evidence +
        (item.aliases.length ? `<p>Also seen as: ${item.aliases.map(esc).join(', ')}</p>` : '') +
        (item.note ? `<p>${esc(item.note)}</p>` : '') + (opts.detail ? opts.detail(item) : '');
      return `<li class="hs-row${ranked && item.tier ? ' hs-t-' + esc(item.tier) : ''}" data-id="${esc(item.id)}" tabindex="0">
        ${rank}<span class="hs-mv ${esc(mv.cls)}" title="${esc(mv.title)}">${esc(mv.text)}</span>
        <div class="hs-main"><b class="hs-title">${esc(item.title)}</b><span class="hs-reason">${esc(item.reason)}</span><span class="hs-meta">${meta.map(esc).join(' · ')}</span></div>
        <div class="hs-acts">${buttons}</div><button type="button" class="hs-more" aria-expanded="false">Details</button>
        <div class="hs-detail" hidden>${detail}</div></li>`;
    }
    const list = view.items.length ? `<ol class="hs-list">${view.items.slice(0, topOpen).map(row).join('')}</ol>` +
      (view.items.length > topOpen ? `<details class="hs-rest"><summary>Show ${view.items.length - topOpen} more</summary><ol class="hs-list" start="${topOpen + 1}">${view.items.slice(topOpen).map(row).join('')}</ol></details>` : '')
      : `<p class="hs-empty">${esc(opts.emptyText == null ? 'Nothing here yet.' : opts.emptyText)}</p>`;
    return `<div class="hs" data-board="${esc(view.board)}"><div class="hs-bar">
      <input class="hs-q" type="search" value="${esc(query)}" placeholder="Search all ${esc(view.counts.total)}" aria-label="Search">
      <div class="hs-filter">${filterHtml}</div><span class="hs-run">${esc(runText)}</span></div>${tierHtml}${list}</div>`;
  }
  function wire(root, handlers) {
    root.hsHandlers = handlers;
    if (root.dataset.hsWired) return;
    root.dataset.hsWired = '1';
    let timer;
    function toggle(row) {
      const panel = row.querySelector('.hs-detail'), button = row.querySelector('.hs-more');
      panel.hidden = !panel.hidden;
      button.setAttribute('aria-expanded', String(!panel.hidden));
    }
    root.addEventListener('click', event => {
      const button = event.target.closest('.hs-act, .hs-more, .hs-filter button, [data-learned-more]');
      if (!button || !root.contains(button)) return;
      if (button.matches('.hs-act')) {
        if (button.disabled) return;
        if (button.dataset.confirm && !button.classList.contains('arm')) {
          button.classList.add('arm');
          const label = button.textContent;
          button.textContent = 'Sure?';
          button.hsArmTimer = setTimeout(() => { button.classList.remove('arm'); button.textContent = label; flushPaint(root); }, 3000);
          button.hsLabel = label;
          return;
        }
        if (button.dataset.confirm) {
          clearTimeout(button.hsArmTimer);
          button.classList.remove('arm');
          button.textContent = button.hsLabel;
        }
        const result = root.hsHandlers.onAction(button.dataset.id, button.dataset.status, button);
        if (result && typeof result.then === 'function') {
          button.disabled = true;
          Promise.resolve(result).finally(() => { button.disabled = false; flushPaint(root); });
        }
      } else if (button.matches('.hs-more')) toggle(button.closest('.hs-row'));
      else if (button.matches('[data-learned-more]')) root.hsHandlers.onMore();
      else {
        clearTimeout(timer);
        root.hsHandlers.onFilter({ query: root.querySelector('.hs-q').value, status: button.dataset.status });
      }
    });
    root.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target.matches('.hs-row')) {
        event.preventDefault();
        toggle(event.target);
      }
    });
    root.addEventListener('input', event => {
      if (!event.target.matches('.hs-q')) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const selected = root.querySelector('.hs-filter button.on');
        root.hsHandlers.onFilter({ query: event.target.value, status: selected.dataset.status });
      }, 250);
    });
  }
  function paintBlocked(root) {
    return !!root.querySelector('.hs-act.arm, .hs-act:disabled');
  }
  function flushPaint(root) {
    if (!root.hsPendingMarkup || paintBlocked(root)) return false;
    const markup = root.hsPendingMarkup;
    root.hsPendingMarkup = null;
    return paint(root, markup);
  }
  // Swap in new markup, retaining interaction state that belongs to the standings board.
  function paint(root, markup) {
    if (paintBlocked(root)) { root.hsPendingMarkup = markup; return false; }
    root.hsPendingMarkup = null;
    const q = root.querySelector('.hs-q'), typing = !!q && root.ownerDocument.activeElement === q;
    const caret = typing ? [q.selectionStart, q.selectionEnd] : null, typed = typing ? q.value : null;
    const openRows = new Set([...root.querySelectorAll('.hs-row[data-id]')]
      .filter(row => !row.querySelector('.hs-detail').hidden).map(row => row.dataset.id));
    const rest = root.querySelector('details.hs-rest'), restOpen = !!rest && rest.open;
    root.innerHTML = markup;
    root.querySelectorAll('.hs-row[data-id]').forEach(row => {
      if (!openRows.has(row.dataset.id)) return;
      const panel = row.querySelector('.hs-detail'), button = row.querySelector('.hs-more');
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    });
    const nextRest = root.querySelector('details.hs-rest');
    if (nextRest) nextRest.open = restOpen;
    const next = typing && root.querySelector('.hs-q');
    // a repaint that lands mid-typing keeps the unsent text; the search debounce sends it
    if (next) { next.value = typed; next.focus(); try { next.setSelectionRange(caret[0], caret[1]); } catch (_) {} }
    return true;
  }
  return { html, wire, movement, paint, controller, detail };
});
