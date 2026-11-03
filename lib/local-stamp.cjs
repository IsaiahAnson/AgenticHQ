'use strict';
/* File-name stamps for reports: the local day and 24-hour time, "20261101-1801" for 6:01 PM on Nov 1. Deck-run
   reports used the UTC ISO stamp, so an evening run was named for the next day. Same shape artifact-retention reads.
   Tested in test/local-stamp.test.cjs. */
const pad = n => String(n).padStart(2, '0');

function localStamp(at = new Date()) {
  const d = new Date(at);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

module.exports = { localStamp };
