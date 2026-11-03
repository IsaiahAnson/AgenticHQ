'use strict';

const path = require('path');

const taskId = routine => routine.path ? path.basename(path.dirname(routine.path)) : String(routine.id || '').replace(/^rt:task-/, '');
const pulseStatus = pulse => {
  const last = pulse?.lastRun;
  if (last && typeof last.ok === 'boolean') return last.ok ? 'ok' : 'fail';
  const strip = Array.isArray(pulse?.strip) ? pulse.strip : [];
  return strip.length ? strip[strip.length - 1].status || null : null;
};

function sentinelRows(state) {
  return Object.entries(state || {}).filter(([id, value]) => id.startsWith('routine-missed:') && value?.data)
    .map(([key, value]) => ({ key, ok: value.ok, ...value.data }));
}

function build({ all, rows, sentinel = {}, models = {}, now = Date.now() } = {}) {
  if (!rows || typeof rows !== 'object') return rows;
  const observations = sentinelRows(sentinel);
  const byTask = new Map(observations.filter(row => row.source === 'desktop').map(row => [row.id, row]));
  const missed = observations.filter(row => row.ok === false)
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  const out = { ...rows,
    models: Object.fromEntries(Object.entries(models).map(([id, value]) => [id, value.model])),
    missed,
    routines: (rows.routines || []).map(routine => {
      const hit = byTask.get(String(routine.id).replace(/^rt:task-/, ''));
      return hit ? { ...routine, missed: hit.missed || 0, lastRunAt: hit.lastRunAt || null,
        lastResult: hit.lastResult ?? null, status: hit.status || (hit.ok === false ? 'missed' : 'ok') } : routine;
    })
  };
  if (all && Array.isArray(all.routines)) out.switches = all.routines
    .filter(routine => routine.origin === 'desktop scheduler' && routine.status !== 'ondemand' && !(routine.once && routine.once < now))
    .map(routine => {
      const task = taskId(routine), hit = byTask.get(task);
      return { task, name: routine.name, on: routine.status === 'active', when: routine.scheduleText,
        model: (models[routine.id] || {}).model || '', missed: hit?.missed || 0, lastRunAt: hit?.lastRunAt || null,
        lastResult: hit?.lastResult ?? null, status: hit?.status || (hit ? (hit.ok === false ? 'missed' : 'ok') : null) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function fillFromPulse(payload) {
  if (!payload || !Array.isArray(payload.switches)) return payload;
  return { ...payload, switches: payload.switches.map(item => {
    const last = item.pulse?.lastRun;
    return { ...item,
      lastRunAt: item.lastRunAt || last?.at || null,
      lastResult: item.lastResult ?? (typeof last?.ok === 'boolean' ? last.ok : null),
      status: item.status || pulseStatus(item.pulse) };
  }) };
}

module.exports = { taskId, sentinelRows, build, fillFromPulse };
