'use strict';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

const timestamp = value => {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function prune(history, now = Date.now()) {
  const cutoff = Number(now) - DAY_MS;
  return (Array.isArray(history) ? history : [])
    .map(timestamp)
    .filter(at => at !== null && at >= cutoff && at <= Number(now))
    .sort((a, b) => a - b);
}

function shouldRestart(history, now = Date.now()) {
  const kept = prune(history, now);
  const recent = kept.filter(at => at >= Number(now) - HOUR_MS).length;
  return { allowed: recent < 3, recent, history: kept };
}

function record(history, now = Date.now()) {
  return prune([...(Array.isArray(history) ? history : []), Number(now)], now);
}

function guardState(value, now = Date.now()) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const crashes = (Array.isArray(source.crashes) ? source.crashes : [])
    .map(item => ({ ...item, at: timestamp(item?.at) }))
    .filter(item => item.at !== null && item.at >= Number(now) - DAY_MS && item.at <= Number(now))
    .sort((a, b) => a.at - b.at);
  return { ...source, crashes };
}

function observeCrash(value, crash, now = Date.now()) {
  const next = guardState(value, now);
  const at = timestamp(crash?.at) ?? Number(now);
  if (at < Number(now) - DAY_MS || at > Number(now)) return next;
  if (!next.crashes.some(item => item.at === at && item.id === crash?.id)) next.crashes.push({ ...crash, at });
  next.crashes.sort((a, b) => a.at - b.at);
  const recent = next.crashes.filter(item => item.at >= Number(now) - HOUR_MS);
  const delay = BACKOFF_MS[Math.min(Math.max(recent.length - 1, 0), BACKOFF_MS.length - 1)];
  next.backoffUntil = at + delay;
  if (recent.length >= 3) next.holdUntil = Math.max(Number(next.holdUntil) || 0, at + HOUR_MS);
  return next;
}

function companionDecision(value, now = Date.now()) {
  const state = guardState(value, now);
  const recent = state.crashes.filter(item => item.at >= Number(now) - HOUR_MS);
  if (Number(state.holdUntil) > Number(now)) return { allowed: false, reason: 'flapping-hold', retryAt: Number(state.holdUntil), recent: recent.length, state };
  if (Number(state.backoffUntil) > Number(now)) return { allowed: false, reason: 'backoff', retryAt: Number(state.backoffUntil), recent: recent.length, state };
  return { allowed: true, reason: null, retryAt: null, recent: recent.length, state };
}

function observeHealthy(value, { now = Date.now(), startedAt } = {}) {
  const state = guardState(value, now);
  if (Number(state.holdUntil) > Number(now)) delete state.holdUntil;
  const started = timestamp(startedAt);
  if (started !== null && Number(now) - started >= HOUR_MS) {
    state.crashes = [];
    delete state.backoffUntil;
    delete state.holdUntil;
    delete state.flappingEmittedAt;
  }
  return state;
}

function takeFlappingEvent(value, now = Date.now()) {
  const state = guardState(value, now);
  const recent = state.crashes.filter(item => item.at >= Number(now) - HOUR_MS);
  if (recent.length < 3 || state.flappingEmittedAt) return { emit: false, state, crash: recent.at(-1) || null };
  state.flappingEmittedAt = Number(now);
  return { emit: true, state, crash: recent.at(-1) };
}

module.exports = { BACKOFF_MS, DAY_MS, HOUR_MS, companionDecision, guardState, observeCrash, observeHealthy, prune, record, shouldRestart, takeFlappingEvent };
