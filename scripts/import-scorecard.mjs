// Fills schools/{id}.academics from the US Dept. of Education College Scorecard API.
// Free key: https://api.data.gov/signup/ . Run yearly (or schedule it).
//
//   SCORECARD_API_KEY=… GOOGLE_APPLICATION_CREDENTIALS=key.json GCLOUD_PROJECT=laxhq-dev node scripts/import-scorecard.mjs
//
// Average high-school GPA isn't in the Scorecard; it comes from each school's Common Data Set
// (refreshAcademics, after launch). Rows that can't be matched are listed for a manual id.
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const FIELDS = [
  'id', 'school.name', 'school.city', 'school.state',
  'latest.admissions.admission_rate.overall',
  'latest.admissions.sat_scores.25th_percentile.critical_reading',
  'latest.admissions.sat_scores.25th_percentile.math',
  'latest.admissions.sat_scores.75th_percentile.critical_reading',
  'latest.admissions.sat_scores.75th_percentile.math',
  'latest.admissions.act_scores.25th_percentile.cumulative',
  'latest.admissions.act_scores.75th_percentile.cumulative',
  'latest.student.size',
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sum = (a, b) => (num(a) != null && num(b) != null ? a + b : null);

/** Map one Scorecard result to our academics fields. */
export function toAcademics(r) {
  return {
    ipedsId: r.id ?? null,
    admitRate: num(r['latest.admissions.admission_rate.overall']),
    sat25: sum(r['latest.admissions.sat_scores.25th_percentile.critical_reading'], r['latest.admissions.sat_scores.25th_percentile.math']),
    sat75: sum(r['latest.admissions.sat_scores.75th_percentile.critical_reading'], r['latest.admissions.sat_scores.75th_percentile.math']),
    act25: num(r['latest.admissions.act_scores.25th_percentile.cumulative']),
    act75: num(r['latest.admissions.act_scores.75th_percentile.cumulative']),
    undergrad: num(r['latest.student.size']),
  };
}

/** Pick the result for our school: same state, and the closest name. */
export function bestMatch(results, school) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z]+/g, ' ').trim();
  const want = norm(school.name);
  const inState = results.filter((r) => r['school.state'] === school.state);
  return inState.find((r) => norm(r['school.name']) === want)
    || inState.find((r) => norm(r['school.name']).includes(want) || want.includes(norm(r['school.name'])))
    || (inState.length === 1 ? inState[0] : null);
}

async function main() {
  const key = process.env.SCORECARD_API_KEY;
  if (!key) throw new Error('Set SCORECARD_API_KEY (free at https://api.data.gov/signup/).');
  if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-laxhq' });
  const db = getFirestore();
  const snap = await db.collection('schools').get();
  const misses = [];
  for (const doc of snap.docs) {
    const s = doc.data();
    const q = new URLSearchParams({ api_key: key, fields: FIELDS.join(','), per_page: '20' });
    if (s.academics?.ipedsId) q.set('id', s.academics.ipedsId);
    else { q.set('school.name', s.name.replace(/\(.*?\)/g, '').trim()); q.set('school.state', s.state); }
    const res = await fetch(`https://api.data.gov/ed/collegescorecard/v1/schools?${q}`);
    if (!res.ok) { misses.push(`${doc.id}: HTTP ${res.status}`); continue; }
    const { results = [] } = await res.json();
    const hit = s.academics?.ipedsId ? results[0] : bestMatch(results, s);
    if (!hit) { misses.push(`${doc.id}: no match for "${s.name}" in ${s.state}`); continue; }
    await doc.ref.set({ academics: { ...(s.academics || {}), ...toAcademics(hit), scorecardYear: new Date().getFullYear() } }, { merge: true });
    process.stdout.write('.');
  }
  console.log(`\nUpdated ${snap.size - misses.length} of ${snap.size} schools.`);
  if (misses.length) console.log(`Not matched (set academics.ipedsId by hand and re-run):\n${misses.join('\n')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
