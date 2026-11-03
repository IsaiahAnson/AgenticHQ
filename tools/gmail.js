/**
 * Gmail reader for the Agentic OS email widget (local addition).
 * Reuses an existing Google sign-in folder in place (its credentials.json and token.json,
 * folder set in os-config.json "email"."googleDir"). Read only: it lists messages and reads
 * their headers, and never writes the token file back, so the tool that signed in keeps owning it.
 *
 * Usage:
 *   node tools/gmail.js rows <googleDir>   - JSON to stdout: last 24 hours of the inbox, newest first
 *   node tools/gmail.js drafts <googleDir> - JSON to stdout: ids of the drafts Gmail still has
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const dir = process.argv[3];
const cmd = process.argv[2];
if (!['rows', 'drafts'].includes(cmd) || !dir) { console.log('Usage: node tools/gmail.js rows|drafts <googleDir>'); process.exit(1); }
const credFile = join(dir, 'credentials.json'), tokenFile = join(dir, 'token.json');
if (!existsSync(credFile) || !existsSync(tokenFile)) { console.error(`No credentials.json or token.json in ${dir}`); process.exit(1); }

const raw = JSON.parse(readFileSync(credFile, 'utf8'));
const c = raw.installed || raw.web || raw;
const auth = new google.auth.OAuth2(c.client_id, c.client_secret);
auth.setCredentials(JSON.parse(readFileSync(tokenFile, 'utf8')));
const gmail = google.gmail({ version: 'v1', auth });

async function rows() {
  const { data: list } = await gmail.users.messages.list({ userId: 'me', q: 'newer_than:1d -category:promotions', maxResults: 40 });
  const ids = (list.messages || []).slice(0, 18).map(m => m.id);
  const out = await Promise.all(ids.map(id => gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From'] })
    .then(({ data: m }) => {
      const h = {}; (m.payload?.headers || []).forEach(x => h[x.name.toLowerCase()] = x.value);
      return { id, subject: h.subject || '(no subject)', rawFrom: h.from || '', unread: (m.labelIds || []).includes('UNREAD'),
               ts: +(m.internalDate || 0), snippet: (m.snippet || '').slice(0, 90) };
    }).catch(() => null)));
  console.log(JSON.stringify({ total: list.resultSizeEstimate || 0, rows: out.filter(Boolean).sort((a, b) => b.ts - a.ts) }));
}
async function drafts() {
  const ids = [];
  let pageToken;
  do {
    const { data } = await gmail.users.drafts.list({ userId: 'me', maxResults: 500, pageToken });
    (data.drafts || []).forEach(d => ids.push(d.id));
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < 2000);
  console.log(JSON.stringify({ ids }));
}
(cmd === 'drafts' ? drafts() : rows()).catch(e => { console.error(e.message); process.exit(1); });
