'use strict';

const STATUSES = new Set(['ok', 'fail', 'miss', 'none', 'unknown']);

function pulseShape(row, days) {
  const dots = Array.isArray(row.dots) ? row.dots : [];
  const useful = row.useful == null ? null : row.useful;
  return {
    pulse: {
      strip: days.map((day, index) => ({
        day,
        status: STATUSES.has(dots[index]) ? dots[index] : 'unknown'
      })),
      kept: useful === null ? null : useful.kept,
      opened: useful === null ? null : useful.opened,
      trashed: useful === null ? null : useful.trashed,
      total: useful === null ? null : useful.total,
      noisy: row.noisy,
      lastRun: row.lastRun || null,
      open: row.open || null
    }
  };
}

function routineMatches(row, routine) {
  const rowId = String(row.id || '');
  const routineId = String(routine.id || '');
  if (rowId.startsWith('desktop-')) return routineId === 'rt:task-' + rowId.slice('desktop-'.length);
  if (rowId.startsWith('windows-')) {
    const slug = rowId.slice('windows-'.length).replace(/^agentic-hq-/, '');
    return routineId.replace(/^rt:(hq-)?/, '') === slug;
  }
  return false;
}

function switchMatches(row, routineSwitch) {
  const rowId = String(row.id || '');
  return rowId.startsWith('desktop-') && String(routineSwitch.task || '') === rowId.slice('desktop-'.length);
}

function errorMessage(pulse) {
  if (!pulse) return 'no pulse';
  const error = pulse.error;
  return String(error && (error.message || error) || 'no pulse');
}

function attachPulse(routines, pulse) {
  const payload = routines && typeof routines === 'object' && !Array.isArray(routines) ? routines : {};
  if (!pulse || pulse.error) return { ...payload, pulseOthers: [], pulseError: errorMessage(pulse) };

  const days = Array.isArray(pulse.days) ? pulse.days.slice() : [];
  const rows = Array.isArray(pulse.rows) ? pulse.rows : [];
  const routineItems = Array.isArray(payload.routines) ? payload.routines : [];
  const switches = Array.isArray(payload.switches) ? payload.switches : [];
  const matchedRows = new Set();

  const attachedRoutines = routineItems.map(routine => {
    const index = rows.findIndex(row => routineMatches(row, routine));
    if (index < 0) return { ...routine };
    matchedRows.add(index);
    return { ...routine, ...pulseShape(rows[index], days) };
  });
  const attachedSwitches = switches.map(routineSwitch => {
    const row = rows.find(candidate => switchMatches(candidate, routineSwitch));
    return row ? { ...routineSwitch, ...pulseShape(row, days) } : { ...routineSwitch };
  });
  const pulseOthers = rows.flatMap((row, index) => matchedRows.has(index) ? [] : [{
    id: row.id,
    name: row.name,
    kind: row.kind,
    ...pulseShape(row, days)
  }]);

  return {
    ...payload,
    routines: attachedRoutines,
    switches: attachedSwitches,
    pulseOthers,
    pulseDays: days,
    keptDays: pulse.keptDays
  };
}

module.exports = { attachPulse };
