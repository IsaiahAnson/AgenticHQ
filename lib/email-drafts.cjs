'use strict';

// Email drafts waiting for you (hq-email-drafts spec). An email-digest routine writes reply drafts
// in Gmail and logs each one in its Google sign-in folder's drafts.json; /api/email shows the ones that
// are still drafts. A draft you sent or deleted is gone from Gmail, so it drops off.

const fs = require('node:fs');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readDrafts(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (_) { return []; }
}

const nameOnly = from => String(from || '').replace(/<.*/, '').replace(/"/g, '').trim() || String(from || '').replace(/[<>]/g, '');

/* live: Set of draft ids Gmail still has, or null when Gmail could not be asked; then entries older
   than 7 days drop instead. Newest first. */
function waitingDrafts(entries, live, now = Date.now()) {
  return (entries || [])
    .filter(e => e && typeof e.draftId === 'string' && /^[A-Za-z0-9_-]+$/.test(String(e.threadId || '')))
    .filter(e => live ? live.has(e.draftId) : now - Date.parse(e.created) < MAX_AGE_MS)
    .sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0))
    .map(e => ({
      subject: String(e.subject || '(no subject)'),
      from: nameOnly(e.from),
      why: String(e.why || ''),
      created: e.created || null,
      link: 'https://mail.google.com/mail/u/0/#all/' + e.threadId
    }));
}

module.exports = { readDrafts, waitingDrafts, MAX_AGE_MS };
