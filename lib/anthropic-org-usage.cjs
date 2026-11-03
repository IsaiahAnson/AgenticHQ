'use strict';

const COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report';

function monthStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function fetchOrgCost({ key, now = new Date(), fetchImpl = fetch }) {
  if (!key) return { available: false, reason: 'Set ANTHROPIC_ADMIN_KEY for live organization spend' };
  let page = '', cents = 0, pages = 0;
  do {
    const url = new URL(COST_URL);
    url.searchParams.set('starting_at', monthStart(now));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', '31');
    if (page) url.searchParams.set('page', page);
    const response = await fetchImpl(url, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Cost report HTTP ${response.status}`);
    const report = await response.json();
    if (!Array.isArray(report.data)) throw new Error('Cost report format changed');
    for (const bucket of report.data) for (const entry of bucket.results || []) {
      const amount = Number(entry.amount);
      if (Number.isFinite(amount)) cents += amount;
    }
    page = report.has_more ? String(report.next_page || '') : '';
    if (report.has_more && !page) throw new Error('Cost report pagination missing cursor');
  } while (page && ++pages < 6);
  if (page) throw new Error('Cost report exceeded page limit');
  return { available: true, usd: Math.round(cents) / 100, checkedAt: now.toISOString() };
}

module.exports = { fetchOrgCost };
