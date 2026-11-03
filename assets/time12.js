/* time12: the one way HQ shows a clock time to a person ("5:42 PM"). Browser (window.HQTime) and Node (require).
   Display only: ISO stamps, file-name stamps, cron and sort keys stay 24-hour. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HQTime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const cache = new Map();
  const fmt = (opts) => {
    const key = JSON.stringify(opts);
    if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat('en-US', Object.assign({ hour: 'numeric', minute: '2-digit', hour12: true }, opts)));
    return cache.get(key);
  };
  const toDate = v => v == null || v === '' ? new Date(NaN) : v instanceof Date ? v : new Date(typeof v === 'string' && /^\d+$/.test(v) ? +v : v);
  /* "5:42 PM"; opts: { tz, seconds } */
  function time(v, opts = {}) {
    const d = toDate(v); if (isNaN(d)) return '';
    return fmt({ timeZone: opts.tz || undefined, second: opts.seconds ? '2-digit' : undefined }).format(d).replace(/ /g, ' ');
  }
  /* "Wed 5:42 PM", "Oct 29, 5:42 PM" or "Wed, Oct 29, 5:42 PM"; opts: { tz, weekday, date, year } */
  function dateTime(v, opts = {}) {
    const d = toDate(v); if (isNaN(d)) return '';
    const o = { timeZone: opts.tz || undefined };
    if (opts.weekday) o.weekday = 'short';
    if (opts.date !== false && !opts.weekday || opts.date) { o.month = 'short'; o.day = 'numeric'; }
    if (opts.year) o.year = 'numeric';
    return fmt(o).format(d).replace(/ /g, ' ').replace(/^(\w{3}),(?= \d)/, '$1');
  }
  /* "21:42" or 1302 (minutes after midnight) -> "9:42 PM"; anything else comes back unchanged */
  function hm(v) {
    let h, m;
    if (typeof v === 'number') { if (!Number.isInteger(v) || v < 0 || v >= 1440) return v; h = Math.floor(v / 60); m = v % 60; }
    else { const x = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(String(v)); if (!x) return v; h = +x[1]; m = +x[2]; }
    return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM');
  }
  /* rewrite zero-padded 24-hour "HH:MM" inside display text ("daily at 07:00, 21:42" -> "daily at 7:00 AM, 9:42 PM").
     Skips one-digit hours ("3:45" may be a score), seconds, offsets (+05:30), ISO pieces (T21:42), ratios and AM/PM times. */
  function text(s) {
    return String(s).replace(/(^|[^\w:.+\/-])([01]\d|2[0-3]):([0-5]\d)(?![\d:.\/])(?!\s*[AaPp]\.?\s?[Mm])/g, (all, pre, h, m) => pre + hm(h + ':' + m));
  }
  /* "cron 0 9,18 * * 1-5" -> "weekdays · 9:00 AM & 6:00 PM"; anything that isn't a plain 5-field cron comes back unchanged */
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function cron(c) {
    const p = String(c || '').replace(/^cron\s+/, '').trim().split(/\s+/);
    if (p.length !== 5 || /[^\d,*]/.test(p[0] + p[1]) || /,/.test(p[0])) return c;
    const [mi, hr, dom, mon, dw] = p, min = mi === '*' ? 0 : +mi;
    const times = hr === '*' ? 'every hour' : hr.split(',').map(h => hm(+h * 60 + min)).join(' & ');
    let days = 'daily';
    if (dw !== '*') days = dw === '1-5' ? 'weekdays' : dw === '0,6' || dw === '6,0' ? 'weekends' : dw.split(',').map(x => DOW[+x % 7] || x).join(', ');
    if (dom !== '*' || mon !== '*') days = 'day ' + dom + (mon !== '*' ? ' of month ' + mon : '');
    return days + ' · ' + times;
  }
  return { time, dateTime, hm, text, cron };
});
