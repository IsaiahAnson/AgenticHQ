'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const held = new Map();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function withLock(file, fn, { timeoutMs = 60000, staleMs = 30000, busyMessage = 'Store is busy' } = {}) {
  const lock = path.resolve(file) + '.lock';
  const existing = held.get(lock);
  if (existing) {
    existing.count++;
    try { return fn(); } finally { existing.count--; }
  }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const start = Date.now(), owner = { pid: process.pid, at: Date.now(), token: crypto.randomUUID() };
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lock);
        let dead = false;
        try {
          const record = JSON.parse(fs.readFileSync(lock, 'utf8'));
          if (Number.isInteger(record.pid) && record.pid > 0) {
            try { process.kill(record.pid, 0); } catch (e) { if (e.code === 'ESRCH') dead = true; else if (e.code !== 'EPERM') throw e; }
          }
        } catch (e) { if (e.code === 'ENOENT') continue; if (!(e instanceof SyntaxError)) throw e; }
        if (dead || Date.now() - stat.mtimeMs > staleMs) {
          const current = fs.statSync(lock);
          if (stat.ino === current.ino && stat.mtimeMs === current.mtimeMs) fs.unlinkSync(lock);
          continue;
        }
      } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) throw Object.assign(new Error(busyMessage), { code: 'STORE_BUSY', status: 503 });
      Atomics.wait(sleeper, 0, 0, Math.min(50, remaining));
      continue;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(owner));
    } catch (error) {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
      throw error;
    }
    fs.closeSync(fd);
    held.set(lock, { count: 1 });
    try { return fn(); } finally {
      held.delete(lock);
      try {
        const current = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (current.token === owner.token) fs.unlinkSync(lock);
      } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    }
  }
}

module.exports = { withLock };
