/* Local add-ons (lib/addons.cjs "brain"): board tabs kept in addons/<name>/ on this computer only. Asks /api/addons,
   adds each add-on's styles, then loads its board scripts in order; those call UsageBoard.addView, and views.js
   adds the tab. A fresh clone has no add-ons, so this adds nothing. */
(function () {
  if (!/^https?:$/.test(location.protocol)) return;
  const load = src => new Promise(resolve => {
    const s = document.createElement('script');
    s.src = src; s.async = false;
    s.onload = s.onerror = () => resolve();
    document.body.appendChild(s);
  });
  fetch('/api/addons').then(r => r.ok ? r.json() : { addons: [] }).then(async ({ addons = [] }) => {
    for (const a of addons) for (const href of a.brain?.styles || []) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = '/' + href;
      document.head.appendChild(l);
    }
    for (const a of addons) for (const src of a.brain?.scripts || []) await load('/' + src);
  }).catch(() => { });
})();
