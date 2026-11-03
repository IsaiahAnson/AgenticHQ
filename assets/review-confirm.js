/* The trusted half of the Review bar. Ring pages are served sandboxed (opaque origin, see RING_CSP in
   server.js), so the bar cannot call HQ itself: it opens this HQ-origin window and posts the request
   here. Nothing runs until he presses Run in this window, which a ring page can neither script nor cover.
   Everything shown comes from the page, so it is rendered as text only. The server still checks the file. */
(function () {
  const $ = id => document.getElementById(id);
  const opener = window.opener;
  const tell = msg => { try { opener && opener.postMessage(msg, '*'); } catch (_) { } };   /* the page's origin is opaque, so '*' */
  const say = (text, err) => { $('status').textContent = text || ''; $('status').classList.toggle('err', !!err); tell({ type: 'rubric-review-status', text, err: !!err }); };
  const MODELS = new Set(['sonnet', 'opus', 'haiku']), EFFORTS = new Set(['low', 'medium', 'high']);
  let req = null, started = false;

  if (!opener || window.top !== window) { $('h').textContent = 'Nothing to confirm'; $('sub').textContent = 'Open this from the Review bar on a ring page.'; $('run').hidden = true; return; }
  /* only a ring page served by this HQ may ask: its origin is opaque ("null") and its bar carries the ring
     nonce from its own script tag, which a website that opens this window cannot read */
  const ringNonce = fetch('/api/ring-nonce').then(r => r.json()).then(j => j.ring || null).catch(() => null);

  addEventListener('message', async e => {
    if (e.source !== opener || e.origin !== 'null' || req) return;
    const d = e.data || {};
    if (d.type !== 'rubric-review-request' || !['apply', 'format'].includes(d.action)) return;
    const ring = await ringNonce;
    if (req) return;
    if (!ring || d.ring !== ring) { say('That request did not come from a ring page on this HQ (or HQ restarted: reload the page).', true); return; }
    const file = String(d.file || '').slice(0, 200), model = String(d.model || ''), effort = String(d.effort || '');
    if (!/^[^/\\]+\.html?$/i.test(file) || !MODELS.has(model) || !EFFORTS.has(effort)) { say('That request was not a ring page with a known model and effort.', true); return; }
    req = { action: d.action, file, model, effort, title: String(d.title || '').slice(0, 200) };
    const list = $('list');
    if (d.action === 'apply') {
      req.comments = (Array.isArray(d.comments) ? d.comments : []).slice(0, 100).map(c => ({ quote: String(c && c.quote || '').slice(0, 600), where: String(c && c.where || '').slice(0, 80), text: String(c && c.text || '').slice(0, 4000) }));
      if (!req.comments.length) { req = null; say('No comments came with that request.', true); return; }
      $('h').textContent = 'Apply ' + req.comments.length + ' comment' + (req.comments.length > 1 ? 's' : '') + '?';
      req.comments.forEach(c => {
        const li = document.createElement('li');
        if (c.quote) { const q = document.createElement('q'); q.textContent = (c.where ? '[' + c.where + '] ' : '') + c.quote; li.append(q); }
        li.append(document.createTextNode(c.text || '(tighten or fix this text)'));
        list.append(li);
      });
      list.hidden = false;
    } else {
      req.name = String(d.name || '').trim().toLowerCase().slice(0, 64); req.notes = String(d.notes || '').trim().slice(0, 2000);
      $('h').textContent = 'Save this format as /' + (req.name || '?') + '?';
      if (req.notes) { const li = document.createElement('li'); li.textContent = req.notes; list.append(li); list.hidden = false; }
    }
    $('sub').replaceChildren('Page ', Object.assign(document.createElement('code'), { textContent: 'artifacts/' + file }), ' · ' + model + ' · ' + effort + (req.action === 'apply' ? ' · an agent edits this page' : ' · an agent drafts a manual-only skill'));
    $('run').disabled = false;   /* no focus: a stray Enter must not start a run */
  });

  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HQ answered ' + r.status);
    return j;
  }
  async function watch(job, label) {
    const t0 = Date.now();
    let misses = 0;
    for (;;) {
      await new Promise(r => setTimeout(r, 3000));
      if (Date.now() - t0 > 20 * 60000 || misses > 10) return { ok: false, text: 'Lost track of the run. Check os-runs/' + job + '.log, then try again.' };
      let s; try { s = await (await fetch('/api/run-status?job=' + encodeURIComponent(job))).json(); } catch (_) { misses++; continue; }
      if (s.error) { misses++; continue; }
      if (s.status === 'running' || s.status === 'queued') { say(label + ' · ' + Math.round((Date.now() - t0) / 1000) + 's'); continue; }
      return s.code === 0 ? { ok: true, text: (s.result || 'Done.').trim() } : { ok: false, text: 'The run failed (exit ' + s.code + '). ' + (s.tail || '') };
    }
  }

  $('run').onclick = async () => {
    if (!req || started) return;
    started = true; $('run').disabled = true; $('cancel').textContent = 'Close';
    try {
      let j, label;
      if (req.action === 'apply') {
        const comments = req.comments.map((c, i) => (i + 1) + '. ' + (c.where ? '[' + c.where + '] ' : '') + (c.quote ? '"' + c.quote + '" -> ' : '') + (c.text || 'tighten or fix this text')).join('\n');
        j = await post('/api/apply-comments', { artifact: req.file, page: '/artifacts/' + req.file, title: req.title, comments, model: req.model, effort: req.effort });
        label = 'Applying comments';
      } else {
        j = await post('/api/save-format', { artifact: req.file, name: req.name, notes: req.notes, model: req.model, effort: req.effort });
        label = 'Building skill ' + req.name;
      }
      say(label + '…');
      const out = await watch(j.job, label);
      say(out.text, !out.ok);
      tell({ type: 'rubric-review-done', action: req.action, ok: out.ok, text: out.text });
      if (out.ok) setTimeout(() => window.close(), 2500);
    } catch (err) { say(err.message, true); tell({ type: 'rubric-review-done', action: req.action, ok: false, text: err.message }); }
  };
  $('cancel').onclick = () => { if (!started) tell({ type: 'rubric-review-done', action: req && req.action, ok: false, cancelled: true, text: 'Cancelled.' }); window.close(); };
  tell({ type: 'rubric-review-ready' });
})();
