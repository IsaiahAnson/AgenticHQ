#!/usr/bin/env node
import { createRequire } from 'node:module';
const { auditKnowledge } = createRequire(import.meta.url)('../lib/context-authority.cjs');
const report = auditKnowledge();
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`HQ knowledge audit: ${report.missing.length} missing sources, ${report.stale.length} notes needing verification, ${report.duplicates.length} exact duplicate notes.`);
  for (const group of ['missing', 'stale', 'duplicates']) for (const item of report[group]) console.log(`${group}: ${JSON.stringify(item)}`);
  console.log(report.note);
}
