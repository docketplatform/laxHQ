// Overlap check between a player's summer plan and their club team's events. Pure; unit tested.
// Both sides compare by local calendar date (yyyy-mm-dd), inclusive on both ends.

/** True when [aStart, aEnd] and [bStart, bEnd] (yyyy-mm-dd strings) share at least one day. */
function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= (bEnd || bStart) && bStart <= (aEnd || aStart);
}

/**
 * @param {Array<{id, title, start, end, status}>} planEvents  start/end are yyyy-mm-dd
 * @param {Array<{id, teamId, teamName, title, startDate, endDate, cancelled}>} teamEvents
 * @returns {Array<{planEventId, planTitle, teamEventId, teamId, teamName, teamTitle, date}>}
 */
function findOverlaps(planEvents, teamEvents) {
  const out = [];
  const plans = planEvents.filter((p) => p.start && !['skipped'].includes(p.status));
  const team = teamEvents.filter((e) => !e.cancelled);
  for (const p of plans) {
    for (const e of team) {
      if (datesOverlap(p.start, p.end || p.start, e.startDate, e.endDate || e.startDate)) {
        out.push({
          planEventId: p.id, planTitle: p.title, teamEventId: e.id, teamId: e.teamId, teamName: e.teamName || null,
          teamTitle: e.title, date: e.startDate > p.start ? e.startDate : p.start,
        });
      }
    }
  }
  return out;
}

/** One alert per plan event, listing its clashes. */
function overlapAlerts(overlaps) {
  const byPlan = new Map();
  for (const o of overlaps) {
    if (!byPlan.has(o.planEventId)) byPlan.set(o.planEventId, []);
    byPlan.get(o.planEventId).push(o);
  }
  return [...byPlan].map(([planEventId, list]) => {
    const first = list[0];
    const fmt = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const more = list.length > 1 ? ` and ${list.length - 1} more` : '';
    return {
      id: `overlap_${planEventId}`,
      key: list.map((o) => o.teamEventId).sort().join(','),
      title: `${first.planTitle} overlaps ${first.teamName ? `${first.teamName}: ` : ''}${first.teamTitle} on ${fmt(first.date)}${more}`,
      refs: { planEventId, teamEventIds: list.map((o) => o.teamEventId).slice(0, 20) },
    };
  });
}

module.exports = { datesOverlap, findOverlaps, overlapAlerts };
