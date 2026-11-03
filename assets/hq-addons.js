/* Local add-ons (lib/addons.cjs): pages kept in addons/<name>/ on this computer only. Asks /api/addons, then adds
   each add-on's dock buttons (before the full-screen button), styles and Micro Apps icons, and loads its page
   scripts in order; those call hqPages.register. A fresh clone has no add-ons, so this adds nothing. */
(function () {
  if (!/^https?:$/.test(location.protocol)) return;
  window.hqAddonIcons = window.hqAddonIcons || {};
  const dock = [];

  /* the toolbar is rebuilt with its widget, so put the buttons back whenever a bare one shows up */
  function placeDock() {
    const bar = document.querySelector('.tbar');
    if (!bar || bar.querySelector('.pgBtn[data-addon]')) return;
    const fs = bar.querySelector('#fsBtn'), sep = fs && fs.previousElementSibling;
    const before = sep && sep.classList.contains('tsep') ? sep : fs;
    for (const d of dock) {
      const b = document.createElement('button');
      b.className = 'pgBtn'; b.dataset.page = d.page; b.dataset.addon = d.addon;
      b.title = d.title + ' page'; b.setAttribute('aria-label', 'Open the ' + d.title + ' page');
      try { b.innerHTML = ico(d.icon); } catch (_) { }
      bar.insertBefore(b, before || null);
    }
  }
  let queued = false;
  const watch = () => new MutationObserver(() => {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; placeDock(); });
  }).observe(document.body, { childList: true, subtree: true });

  function load(src) {
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = s.onerror = () => resolve();
      document.body.appendChild(s);
    });
  }

  fetch('/api/addons').then(r => r.ok ? r.json() : { addons: [] }).then(async ({ addons = [] }) => {
    if (!addons.length) return;
    for (const a of addons) {
      for (const d of a.dock || []) dock.push({ ...d, addon: a.name });
      for (const href of a.styles || []) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = href;
        document.head.appendChild(l);
      }
      Object.assign(window.hqAddonIcons, a.appIcons || {});
    }
    if (dock.length) { placeDock(); watch(); }
    /* app tiles drawn before the icons arrived pick them up on a redraw (only once the apps list is in) */
    try { if (HQ_APPS.length) renderAppRows(); } catch (_) { }
    for (const a of addons) for (const src of a.scripts || []) await load(src);
  }).catch(() => { });
})();
