'use strict';

const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'data', 'claude-api-usage.jsonl');

function recordLocalUsage({ source, model, usage }) {
  if (!usage || !Number.isFinite(Number(usage.input_tokens)) || !Number.isFinite(Number(usage.output_tokens))) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), source, model,
    input: Number(usage.input_tokens), output: Number(usage.output_tokens),
    cacheRead: Number(usage.cache_read_input_tokens) || 0,
    cacheCreate: Number(usage.cache_creation_input_tokens) || 0 }) + '\n');
}

function localUsageThisMonth(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const total = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let rows;
  try { rows = fs.readFileSync(FILE, 'utf8').split(/\r?\n/); } catch (_) { return total; }
  for (const row of rows) {
    if (!row) continue;
    let event; try { event = JSON.parse(row); } catch (_) { continue; }
    if (event.at < start || event.at > now.toISOString()) continue;
    total.calls++;
    for (const key of ['input', 'output', 'cacheRead', 'cacheCreate']) total[key] += Number(event[key]) || 0;
  }
  return total;
}

module.exports = { recordLocalUsage, localUsageThisMonth };
