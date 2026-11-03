'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile: nodeExecFile } = require('child_process');

const DEFAULT_TTL = 60000;
const DEFAULT_TIMEOUT = 5000;

function heartbeat(file, { io = fs, now = Date.now() } = {}) {
  let value;
  try { value = JSON.parse(io.readFileSync(file, 'utf8')); } catch (_) { return { status: 'unknown', stale: false }; }
  const lastBeat = Date.parse(value.lastBeat), beatMs = Number(value.beatMs);
  if (!Number.isFinite(lastBeat) || !Number.isFinite(beatMs) || beatMs <= 0) return { status: 'unknown', stale: false };
  const stale = now - lastBeat > 3 * beatMs;
  return { status: stale ? 'stale' : 'fresh', stale, pid: value.pid ?? null, startedAt: value.startedAt || null,
    lastBeat: value.lastBeat, beatMs };
}

function defaultRunner(command, args, options) {
  /* Node refuses to execFile a .cmd/.bat without a shell (spawn EINVAL); the args here are fixed constants */
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  if (viaShell) { command = '"' + command + '"'; options = { ...options, shell: true }; }
  return new Promise((resolve, reject) => nodeExecFile(command, args, options, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function createHealthProbes(options = {}) {
  const io = options.fs || fs, now = options.now || Date.now, runner = options.runner || defaultRunner;
  const { companions } = require('./places.cjs');
  const heartbeatDir = options.heartbeatDir || path.join(companions, 'logs', 'heartbeats');
  const cassCommand = options.cassCommand || path.join(companions, 'bin', 'cass.cmd');
  const ttlMs = options.ttlMs || DEFAULT_TTL, timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT;
  const cache = new Map(), pending = new Map();

  function refresh(name) {
    if (pending.has(name)) return pending.get(name);
    const task = (async () => {
      if (name !== 'cass') return null;
      let value;
      try {
        const stdout = await runner(cassCommand, ['health', '--json'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 });
        const json = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
        const healthy = json?.ok === true || json?.healthy === true || json?.status === 'healthy' || json?.health_level === 'healthy'
          || json?.health_status === 'healthy' || json?.doctor_summary?.health_status === 'healthy' || json?.doctor_summary?.health_class === 'healthy';
        value = { up: healthy, checkedAt: now(), error: healthy ? null : 'health command did not report healthy' };
      } catch (error) { value = { up: false, checkedAt: now(), error: String(error.message || error).slice(0, 200) }; }
      cache.set(name, value);
      return value;
    })().finally(() => pending.delete(name));
    pending.set(name, task);
    return task;
  }

  function cached(name) {
    const hit = cache.get(name);
    if (!hit || now() - hit.checkedAt >= ttlMs) refresh(name).catch(() => {});
    return hit || null;
  }

  function snapshot(base = {}) {
    const companions = { ...base }, details = {};
    for (const name of new Set([...Object.keys(base), 'cass'])) {
      const beat = heartbeat(path.join(heartbeatDir, name + '.json'), { io, now: now() });
      details[name] = { heartbeat: beat.status, ...(beat.status !== 'unknown' ? beat : {}) };
      if (beat.stale) companions[name] = 'stale';
    }
    const cass = cached('cass');
    details.cass = { ...details.cass, probe: cass ? (cass.up ? 'up' : 'down') : 'unknown', checkedAt: cass?.checkedAt || null,
      error: cass?.error || null };
    if (companions.cass !== 'stale') companions.cass = cass ? cass.up : null;
    return { companions, details };
  }

  return { snapshot, refresh, latest: name => cache.get(name) || null };
}

module.exports = { heartbeat, createHealthProbes, DEFAULT_TTL, DEFAULT_TIMEOUT };
