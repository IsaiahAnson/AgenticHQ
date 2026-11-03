/* Review bar for ring pages (served into every artifacts/*.html by server.js withReviewBar).
   Highlight text -> comment. "Apply all" sends the comments to /api/apply-comments, which edits this
   page's file headlessly. "Save format" asks /api/save-format to turn this page's layout into a new skill.
   Both go through HQ's confirm window (viaHQ below), because ring pages are sandboxed away from HQ.
   Comments wait in localStorage per page when the browser allows it (a sandboxed page usually has none). Opt out per page: <meta name="rubric-review" content="off">. */
(function () {
  if (window.__rubricReview) return;
  window.__rubricReview = true;
  const RING = (document.currentScript && document.currentScript.dataset.ring) || '';   /* HQ's ring nonce, see review-confirm.js */
  const file = decodeURIComponent(location.pathname.replace(/^\/artifacts\//, ''));
  const KEY = 'rubric-review:' + file;
  const load = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter(c => c && typeof c === 'object') : []; } catch (_) { return []; } };
  const save = list => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) { } };
  let comments = load(), open = false, busy = false, pending = null;

  const host = document.createElement('div');
  host.id = 'rubric-review';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }
    .pill, .panel, .pop { position: fixed; z-index: 2147483000; color: #ece6d8; background: #1b1916; border: 1px solid #3a352d; box-shadow: 0 8px 28px rgba(0,0,0,.38); }
    .pill { right: 18px; bottom: 18px; display: flex; align-items: center; gap: 7px; padding: 8px 13px 8px 11px; border-radius: 999px; font: 600 12px/1 "Segoe UI", sans-serif; cursor: pointer; }
    .pill:hover { border-color: #c9a45c; }
    .pill b { min-width: 18px; padding: 2px 5px; border-radius: 9px; background: #c9a45c; color: #1b1916; font-size: 11px; text-align: center; }
    .pill b:empty { display: none; }
    svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .panel { right: 18px; bottom: 64px; width: 340px; max-height: min(70vh, 620px); display: none; flex-direction: column; border-radius: 12px; overflow: hidden; }
    .panel.on { display: flex; }
    header { padding: 14px 16px 10px; border-bottom: 1px solid #2c2822; }
    h2 { margin: 0; font-size: 14px; font-weight: 600; }
    header p { margin: 4px 0 0; font-size: 12px; color: #b3aa98; line-height: 1.4; }
    ol { list-style: none; margin: 0; padding: 6px 16px; overflow-y: auto; flex: 1; }
    li { padding: 9px 0; border-bottom: 1px solid #2c2822; font-size: 12.5px; line-height: 1.45; }
    li q { display: block; color: #d9c08a; font-style: italic; margin-bottom: 3px; }
    li q::before, li q::after { content: ""; }
    li .row { display: flex; gap: 8px; align-items: flex-start; }
    li .row span { flex: 1; }
    li button { background: none; border: 0; color: #8f8778; cursor: pointer; padding: 0 2px; font-size: 12px; }
    li button:hover { color: #ece6d8; }
    .empty { padding: 14px 0; color: #8f8778; font-size: 12.5px; }
    textarea, input, select { width: 100%; background: #12110f; color: #ece6d8; border: 1px solid #3a352d; border-radius: 7px; padding: 8px 9px; font-size: 12.5px; }
    textarea { resize: vertical; min-height: 54px; }
    textarea:focus, input:focus, select:focus, button:focus-visible { outline: 2px solid #c9a45c; outline-offset: 1px; }
    footer { padding: 10px 16px 14px; border-top: 1px solid #2c2822; display: grid; gap: 8px; }
    .dials { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .acts { display: flex; gap: 8px; }
    .acts button, .pop button { flex: 1; padding: 8px 10px; border-radius: 7px; border: 1px solid #3a352d; background: #24211c; color: #ece6d8; font-size: 12.5px; font-weight: 600; cursor: pointer; }
    .acts button.go { background: #c9a45c; border-color: #c9a45c; color: #1b1916; }
    .acts button:disabled { opacity: .45; cursor: default; }
    .status { font-size: 12px; color: #b3aa98; line-height: 1.45; white-space: pre-wrap; max-height: 120px; overflow-y: auto; }
    .status.err { color: #f08a7e; }
    .fmt { display: none; gap: 8px; }
    .fmt.on { display: grid; }
    .pop { display: none; padding: 5px; border-radius: 8px; }
    .pop.on { display: block; }
    .pop button { display: flex; align-items: center; gap: 6px; padding: 6px 10px; }
  </style>
  <div class="pop"><button type="button" data-a="pick"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>Comment</button></div>
  <div class="panel" role="dialog" aria-label="Review this page">
    <header><h2>Review this page</h2><p>Highlight any text to comment on it. Apply all sends every comment to an agent that edits this page.</p></header>
    <ol></ol>
    <footer>
      <textarea placeholder="Comment on the highlighted text, or a note about the whole page" aria-label="New comment"></textarea>
      <div class="acts"><button type="button" data-a="add">Add comment</button></div>
      <div class="dials">
        <select data-k="model" aria-label="Model"><option>opus</option></select>
        <select data-k="effort" aria-label="Effort"><option>medium</option><option>high</option></select>
      </div>
      <div class="acts"><button type="button" class="go" data-a="apply">Apply all</button><button type="button" data-a="format">Save format…</button></div>
      <div class="fmt">
        <input data-k="name" placeholder="new skill name, e.g. ig-graphic" aria-label="New skill name">
        <input data-k="notes" placeholder="What should the skill make? (optional)" aria-label="What the skill makes">
        <div class="acts"><button type="button" class="go" data-a="mkskill">Create skill</button></div>
      </div>
      <div class="status" aria-live="polite"></div>
    </footer>
  </div>
  <button type="button" class="pill" aria-expanded="false"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>Review<b></b></button>`;

  const $ = s => root.querySelector(s);
  const pill = $('.pill'), panel = $('.panel'), list = $('ol'), box = $('textarea'), status = $('.status'), pop = $('.pop'), fmt = $('.fmt');
  const say = (text, err) => { status.textContent = text || ''; status.classList.toggle('err', !!err); };

  function render() {
    pill.querySelector('b').textContent = comments.length || '';
    list.innerHTML = comments.length ? '' : '<li class="empty">No comments yet.</li>';
    comments.forEach((c, i) => {
      const li = document.createElement('li');
      if (c.quote) { const q = document.createElement('q'); q.textContent = c.quote.length > 160 ? c.quote.slice(0, 157) + '…' : c.quote; li.append(q); }
      const row = document.createElement('div'); row.className = 'row';
      const span = document.createElement('span'); span.textContent = c.text || '(tighten or fix this text)';
      const del = document.createElement('button'); del.type = 'button'; del.textContent = 'Remove'; del.setAttribute('aria-label', 'Remove comment ' + (i + 1));
      del.onclick = () => { comments.splice(i, 1); save(comments); render(); };
      row.append(span, del); li.append(row); list.append(li);
    });
    $('[data-a="apply"]').disabled = busy || !comments.length;
    $('[data-a="mkskill"]').disabled = busy;
  }
  function toggle(on) { open = on; panel.classList.toggle('on', on); pill.setAttribute('aria-expanded', on); if (!on) pop.classList.remove('on'); }
  function section(node) {
    for (let el = node && (node.nodeType === 1 ? node : node.parentElement); el && el !== document.body; el = el.parentElement) {
      const h = el.matches('section,article,table,li,figure') && el.querySelector('h1,h2,h3,h4,caption,figcaption');
      if (h) return h.textContent.trim().slice(0, 80);
    }
    return '';
  }

  document.addEventListener('mouseup', e => {
    if (!open || e.composedPath().includes(host)) return;
    setTimeout(() => {
      const sel = window.getSelection(), text = sel && String(sel).trim();
      if (!text) { pop.classList.remove('on'); return; }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      pending = { quote: text.slice(0, 600), where: section(sel.anchorNode) };
      pop.style.left = Math.min(innerWidth - 120, Math.max(8, r.left + r.width / 2 - 50)) + 'px';
      pop.style.top = Math.max(8, r.top - 44) + 'px';
      pop.classList.add('on');
    }, 0);
  });

  /* this page is sandboxed (opaque origin, no HQ access), so Apply all and Save format go through
     /assets/review-confirm.html: an HQ-origin window where he presses Run before anything starts */
  const HQ = new URL('/', location.href).origin;
  let confirmWin = null;
  function viaHQ(request, onDone) {
    const w = window.open('/assets/review-confirm.html', 'rubric-review-confirm', 'popup,width=560,height=640');
    if (!w) { say('Allow pop-ups for this page, then press it again: HQ asks you to confirm in its own window.', true); return; }
    confirmWin = w; busy = true; render(); say('Confirm in the HQ window that just opened…');
    const onMsg = e => {
      if (e.source !== w) return;
      const d = e.data || {};
      if (d.type === 'rubric-review-ready') w.postMessage({ type: 'rubric-review-request', ring: RING, ...request }, HQ);
      if (d.type === 'rubric-review-status') say(d.text, d.err);
      if (d.type === 'rubric-review-done') { finish(); say(d.text, !d.ok && !d.cancelled); if (d.ok && onDone) onDone(); }
    };
    const shut = setInterval(() => { if (w.closed && busy && confirmWin === w) { finish(); say('The HQ window closed. A run you started there keeps going; its log is in os-runs/.'); } }, 1000);
    function finish() { busy = false; render(); clearInterval(shut); removeEventListener('message', onMsg); }
    addEventListener('message', onMsg);
  }
  const dials = () => ({ model: $('[data-k="model"]').value, effort: $('[data-k="effort"]').value });

  root.addEventListener('click', e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    const act = a.dataset.a;
    if (act === 'pick') { pop.classList.remove('on'); box.focus(); box.dataset.quote = pending ? pending.quote : ''; box.dataset.where = pending ? pending.where : ''; say(pending ? 'Commenting on: “' + pending.quote.slice(0, 80) + '”' : ''); return; }
    if (act === 'add') {
      const text = box.value.trim(), quote = box.dataset.quote || (pending && pending.quote) || '';
      if (!text && !quote) { say('Write a comment or highlight some text first.', true); return; }
      comments.push({ quote, where: box.dataset.where || (pending && pending.where) || '', text }); save(comments); pop.classList.remove('on');
      box.value = ''; box.dataset.quote = ''; box.dataset.where = ''; pending = null; say(''); render(); return;
    }
    if (act === 'format') { fmt.classList.toggle('on'); $('[data-k="name"]').focus(); return; }
    if (busy) { if (confirmWin && !confirmWin.closed) confirmWin.focus(); return; }
    if (act === 'apply') viaHQ({ action: 'apply', file, title: document.title, comments, ...dials() },
      () => { comments = []; save(comments); render(); setTimeout(() => location.reload(), 2500); });
    if (act === 'mkskill') viaHQ({ action: 'format', file, name: $('[data-k="name"]').value.trim().toLowerCase(), notes: $('[data-k="notes"]').value.trim(), ...dials() });
  });
  pill.onclick = () => toggle(!open);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) toggle(false); });
  (document.body || document.documentElement).append(host);
  render();
})();
