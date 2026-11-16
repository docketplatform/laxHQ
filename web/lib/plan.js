// Checklist engine: turns the checklist template + a player + today into a dated plan.
// Pure functions only, shared by the app and the unit tests.

export const DAY_MS = 864e5;

/** Local-midnight date for y-m-d (month is 1-12). */
export function ymd(y, m, d) { return new Date(y, m - 1, d); }

/** Strip the time so day math is exact. */
export function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }

export function addDays(date, days) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS); }

/** ISO yyyy-mm-dd in local time. */
export function isoDate(date) {
  const d = startOfDay(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Sept 1 of junior year = Sept 1 of (gradYear - 2). */
export function contactOpensDate(gradYear) { return ymd(gradYear - 2, 9, 1); }

/** June 15 after sophomore year = June 15 of (gradYear - 2). */
export function afterSophomoreDate(gradYear) { return ymd(gradYear - 2, 6, 15); }

/**
 * School year a date falls in, named by the June it ends (Sept 2026 → 2027).
 * The year turns over on Aug 1.
 */
export function schoolYearEnding(today) {
  const d = startOfDay(today);
  return d.getMonth() >= 7 ? d.getFullYear() + 1 : d.getFullYear();
}

/** Current grade for a grad year: 12 in the graduating year, 9 three years earlier. */
export function currentGrade(gradYear, today) {
  return 12 - (gradYear - schoolYearEnding(today));
}

export function gradeLabel(grade) {
  if (grade < 9) return 'Middle school';
  if (grade > 12) return 'Graduated';
  return ({ 9: 'Freshman', 10: 'Sophomore', 11: 'Junior', 12: 'Senior' })[grade];
}

/** Recruiting season key, Sept 1 – Aug 31, e.g. "2026-27". */
export function seasonKey(date) {
  const d = startOfDay(date);
  const start = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function anchorDate(anchor, player) {
  switch (anchor) {
    case 'contactOpens': return contactOpensDate(player.gradYear);
    case 'afterSophomore': return afterSophomoreDate(player.gradYear);
    case 'gradYear': return ymd(player.gradYear, 6, 1);
    default: throw new Error(`Unknown anchor: ${anchor}`);
  }
}

/** Steps LaxHQ can tick by itself from data the family already entered. */
export const AUTO_DONE = {
  profile: (p) => Boolean(p.highSchool?.name && p.academics?.gpa != null && p.club?.name),
  film: (p) => Boolean(p.filmUrl),
};

function applies(item, player) {
  const a = item.appliesTo || {};
  if (a.sports && a.sports.length && !a.sports.includes(player.sport)) return false;
  if (a.positions && a.positions.length && !a.positions.includes(player.position)) return false;
  if (a.divisions && a.divisions.length) {
    const open = player.openDivisions || [];
    if (!a.divisions.some((d) => open.includes(d))) return false;
  }
  return true;
}

/**
 * Build the dated plan for one player.
 * @param {{items: Array}} template  config/checklist
 * @param {object} player            needs gradYear; sport, position, openDivisions optional
 * @param {object} state             checklist/state doc: { done: {id: ts}, skipped: {id: ts}, custom: {id: {title, due}} }
 * @param {Date} today
 * @returns {{ contactOpens: Date, daysToContact: number, grade: number, items: Array,
 *            readiness: number, doneCount: number, dueSoFar: number, thisWeek: Array }}
 */
export function buildPlan(template, player, state = {}, today = new Date()) {
  if (!player || !Number.isInteger(player.gradYear)) throw new Error('player.gradYear is required');
  const done = state.done || {};
  const skipped = state.skipped || {};
  const t = startOfDay(today);

  const items = (template.items || [])
    .filter((item) => applies(item, player))
    .map((item) => {
      const base = anchorDate(item.window?.anchor || 'contactOpens', player);
      const start = addDays(base, item.window?.startDays ?? 0);
      const due = addDays(base, item.window?.dueDays ?? 0);
      let status;
      const auto = item.autoDone && AUTO_DONE[item.autoDone]?.(player);
      if (done[item.id] || auto) status = 'done';
      else if (skipped[item.id]) status = 'skipped';
      else if (t > due) status = 'overdue';
      else if (t >= start) status = 'current';
      else status = 'upcoming';
      return { ...item, start, due, status, custom: false, auto: Boolean(auto) && !done[item.id] };
    });

  for (const [id, c] of Object.entries(state.custom || {})) {
    const due = c.due ? startOfDay(c.due instanceof Date ? c.due : new Date(c.due)) : t;
    const status = done[id] ? 'done' : skipped[id] ? 'skipped' : t > due ? 'overdue' : 'current';
    items.push({ id, title: c.title, detail: c.detail || '', start: due, due, status, custom: true, grade: null });
  }

  items.sort((a, b) => a.due - b.due || a.start - b.start || String(a.id).localeCompare(String(b.id)));

  // Readiness counts the template steps whose window has opened (custom tasks don't count).
  const opened = items.filter((i) => !i.custom && i.start <= t && i.status !== 'skipped');
  const doneCount = opened.filter((i) => i.status === 'done').length;
  const readiness = opened.length ? Math.round((doneCount / opened.length) * 100) : 0;

  const open = items.filter((i) => i.status === 'overdue' || i.status === 'current');
  const recentlyDone = items.filter((i) => i.status === 'done' && i.due >= addDays(t, -7) && i.start <= t);
  const thisWeek = [...open.slice(0, 5), ...recentlyDone.slice(0, Math.max(0, 6 - Math.min(open.length, 5)))];

  const contactOpens = contactOpensDate(player.gradYear);
  return {
    contactOpens,
    daysToContact: daysBetween(t, contactOpens),
    grade: currentGrade(player.gradYear, t),
    items,
    readiness,
    doneCount,
    dueSoFar: opened.length,
    thisWeek,
  };
}

/** Grad years a family can pick today: this year's seniors through about 7th graders. */
export function gradYearOptions(today = new Date()) {
  const first = schoolYearEnding(today);
  return Array.from({ length: 7 }, (_, i) => first + i);
}
