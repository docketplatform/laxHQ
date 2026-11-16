// Fit v1: academic and athletic fit for one player at one school, and list balance.
// Every result is an estimate; families can override the overall tier.
// Pure functions shared by the app and the unit tests.

export const TIERS = ['reach', 'target', 'likely'];
const RANK = { reach: 0, target: 1, likely: 2 };

/**
 * Academic fit from published admissions data.
 * Uses SAT/ACT against the school's middle-50% range when both exist, else GPA against
 * the average admitted GPA. Very selective schools (admit rate ≤ 15%) are never "likely".
 * @returns {{ fit: 'reach'|'target'|'likely'|null, basis: string|null }}
 */
export function academicFit(player, academics) {
  const a = academics || {};
  const pa = player.academics || {};
  let fit = null; let basis = null;

  const act = pa.act != null && a.act25 != null && a.act75 != null ? { v: pa.act, lo: a.act25, hi: a.act75, name: 'ACT' } : null;
  const sat = pa.sat != null && a.sat25 != null && a.sat75 != null ? { v: pa.sat, lo: a.sat25, hi: a.sat75, name: 'SAT' } : null;
  const test = sat || act;
  if (test) {
    fit = test.v < test.lo ? 'reach' : test.v > test.hi ? 'likely' : 'target';
    basis = `${test.name} ${test.v} vs. middle 50% ${test.lo}–${test.hi}`;
  } else if (pa.gpa != null && a.avgHsGpa != null) {
    const gpa = normalizeGpa(pa.gpa, pa.gpaScale, pa.weighted);
    const diff = gpa - a.avgHsGpa;
    fit = diff < -0.15 ? 'reach' : diff > 0.15 ? 'likely' : 'target';
    basis = `GPA ${pa.gpa} vs. admitted average ${a.avgHsGpa}`;
  }
  if (fit && a.admitRate != null && a.admitRate <= 0.15) {
    if (fit === 'likely') fit = 'target';
    if (!test && fit === 'target') fit = 'reach';
    basis += ` · admits ${Math.round(a.admitRate * 100)}%`;
  }
  return { fit, basis };
}

/** Compare GPAs on a 4.0 unweighted-ish scale (weighted 5.0 GPAs are scaled down). */
export function normalizeGpa(gpa, scale = 4, weighted = false) {
  let g = Number(gpa);
  if (scale === 5) g = (g / 5) * 4;
  else if (weighted && g > 4) g = 4;
  return Math.round(g * 100) / 100;
}

/**
 * Athletic level 1 (developing) – 5 (top national recruit), from what the family entered.
 * Club level carries most weight; varsity starter, all-conference and a listed ranking add to it.
 */
export function athleticLevel(player) {
  const club = { national: 3, regional: 2, local: 1 }[player.club?.level] ?? null;
  const ath = player.athletic || {};
  if (club === null && !ath.varsityStarter && !ath.allConference && !(player.rankings || []).length) return null;
  let level = club ?? 1;
  if (ath.varsityStarter) level += 0.5;
  if (ath.allConference) level += 0.5;
  if ((player.rankings || []).length) level += 1;
  return Math.max(1, Math.min(5, Math.round(level)));
}

/**
 * Athletic fit: player level against the program's tier (1 = most competitive, 5 = least).
 * A program "needs" level 6 - tier; two levels short is a reach, one short a target-reach.
 */
export function athleticFit(player, athleticTier) {
  const level = athleticLevel(player);
  if (level == null || athleticTier == null) return { fit: null, level };
  const need = 6 - athleticTier;
  const gap = level - need;
  const fit = gap <= -1 ? 'reach' : gap >= 1 ? 'likely' : 'target';
  return { fit, level, need };
}

/** Overall tier: the harder of the two fits; one missing → the other; both missing → null. */
export function overallTier(academic, athletic) {
  const known = [academic, athletic].filter(Boolean);
  if (!known.length) return null;
  return known.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

/** Everything the schools screen needs for one target. */
export function targetFit(player, target) {
  const school = target.school || {};
  const ac = academicFit(player, school.academics);
  const at = athleticFit(player, school.athleticTier);
  const computed = overallTier(ac.fit, at.fit);
  return {
    academic: ac.fit, academicBasis: ac.basis,
    athletic: at.fit, athleticLevel: at.level,
    computed,
    tier: target.tierOverride || computed,
    overridden: Boolean(target.tierOverride),
  };
}

/**
 * Balance of a list: counts per tier and a warning when it's top-heavy.
 * Top-heavy = with 5+ schools, more than 40% reaches or no likely schools.
 */
export function listBalance(tiers) {
  const counts = { reach: 0, target: 0, likely: 0, unrated: 0 };
  for (const t of tiers) counts[t || 'unrated'] += 1;
  const rated = counts.reach + counts.target + counts.likely;
  let warning = null;
  if (rated >= 5 && counts.reach / rated > 0.4) warning = `Top-heavy: ${counts.reach} of ${rated} are reaches. Aim for about 3 reach, 7 target and 4 likely.`;
  else if (rated >= 5 && counts.likely === 0) warning = 'No likely schools yet. Add a few where you’d clearly fit academically and athletically.';
  return { counts, rated, warning };
}

/** Default program tier from its conference when the catalog has none (an estimate). */
export function defaultAthleticTier(division, conference) {
  if (division === 'D1') {
    if (['Big Ten', 'ACC'].includes(conference)) return 1;
    if (['Ivy League', 'Big East'].includes(conference)) return 2;
    return 3;
  }
  if (division === 'D2') return 4;
  if (division === 'D3') return ['NESCAC', 'Centennial'].includes(conference) ? 4 : 5;
  return null;
}
