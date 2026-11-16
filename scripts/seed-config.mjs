// Seeds the config/* docs: NCAA contact rules, the checklist template and plan limits.
//
// Against the emulator:   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-config.mjs
// Against a real project: GOOGLE_APPLICATION_CREDENTIALS=key.json GCLOUD_PROJECT=laxhq-dev node scripts/seed-config.mjs
//
// Verify every rule below against ncaa.org before seeding production.
// Changing a rule later is a data change: edit this file, bump the version, re-run.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const projectId = process.env.GCLOUD_PROJECT || 'demo-laxhq';
initializeApp({ projectId });
const db = getFirestore();

export const ncaaRules = {
  version: 1,
  sourceUrl: 'https://www.ncaa.org/sports/2018/5/9/recruiting-calendars.aspx',
  verifiedAt: null, // set the date you checked each rule against ncaa.org
  byDivision: {
    D1: {
      contactOpens: { anchor: 'junior', month: 9, day: 1 },
      athleteMayEmailAnytime: true,
      note: 'D1 coaches can start recruiting conversations on Sept 1 of junior year. Athletes may email coaches any time.',
    },
    D2: {
      contactOpens: { anchor: 'afterSophomore', month: 6, day: 15 },
      athleteMayEmailAnytime: true,
      note: 'D2 coaches can contact athletes from June 15 after sophomore year.',
    },
    D3: {
      contactOpens: null,
      athleteMayEmailAnytime: true,
      note: 'D3 has fewer contact restrictions. Check each school.',
    },
  },
};

// Windows are days relative to an anchor: contactOpens = Sept 1 of junior year (gradYear - 2).
export const checklist = {
  version: 1,
  items: [
    { id: 'profile-basics', grade: 9, title: 'Fill in your player profile', detail: 'Grad year, position, high school, club team, GPA', window: { anchor: 'contactOpens', startDays: -1095, dueDays: -1000 }, action: { type: 'open', target: 'profile' } },
    { id: 'ncaa-eligibility', grade: 9, title: 'Learn the NCAA core-course rules', detail: 'D1 and D2 need 16 approved core courses', window: { anchor: 'contactOpens', startDays: -1095, dueDays: -900 } },
    { id: 'first-school-list', grade: 9, title: 'Start a school list of 15–25 programs', detail: 'Mix of D1, D2 and D3 you would attend without lacrosse', window: { anchor: 'contactOpens', startDays: -900, dueDays: -700 }, action: { type: 'open', target: 'schools' } },
    { id: 'fall-film-9', grade: 9, title: 'Save fall-ball game film', detail: 'Full games, not just highlights', window: { anchor: 'contactOpens', startDays: -1030, dueDays: -950 } },
    { id: 'transcript-fall-10', grade: 10, title: 'Upload your fall transcript', detail: 'Unlocks academic fit for your list', window: { anchor: 'contactOpens', startDays: -330, dueDays: -280 }, action: { type: 'open', target: 'profile' } },
    { id: 'soph-reel', grade: 10, title: 'Cut a fall highlight reel', detail: 'Aim for 3–4 minutes, best clips first', window: { anchor: 'contactOpens', startDays: -330, dueDays: -270 }, action: { type: 'open', target: 'card' } },
    { id: 'balance-list', grade: 10, title: 'Balance your list: reach, target, likely', detail: 'Roughly 3 reach, 7 target, 4 likely', window: { anchor: 'contactOpens', startDays: -300, dueDays: -220 }, action: { type: 'open', target: 'schools' } },
    { id: 'intro-emails-d3', grade: 10, title: 'Send intro emails to D3 and D2 targets', detail: 'Athletes may email any time', window: { anchor: 'contactOpens', startDays: -280, dueDays: -200 }, action: { type: 'open', target: 'coaches' } },
    { id: 'questionnaires', grade: 10, title: 'Fill in recruiting questionnaires', detail: 'Every target school has one', window: { anchor: 'contactOpens', startDays: -280, dueDays: -180 }, action: { type: 'open', target: 'schools' } },
    { id: 'summer-plan', grade: 10, title: 'Pick summer events where your targets watch', detail: 'Check overlaps with club dates and the travel budget', window: { anchor: 'contactOpens', startDays: -240, dueDays: -150 }, action: { type: 'open', target: 'events' } },
    { id: 'intro-emails-d1', grade: 10, title: 'Email D1 targets with your summer schedule', detail: 'Coaches can’t reply about recruiting until Sept 1', window: { anchor: 'contactOpens', startDays: -150, dueDays: -60 }, action: { type: 'open', target: 'coaches' } },
    { id: 'test-plan', grade: 10, title: 'Plan when you’ll take the SAT or ACT', detail: 'Many academic schools still weigh scores', window: { anchor: 'contactOpens', startDays: -200, dueDays: -90 } },
    { id: 'summer-reel', grade: 11, title: 'Update your reel with summer film', detail: 'Coaches open it first on Sept 1', window: { anchor: 'contactOpens', startDays: -30, dueDays: -5 }, action: { type: 'open', target: 'card' } },
    { id: 'sept1-ready', grade: 11, title: 'Be ready for Sept 1 calls', detail: 'Questions for coaches, your schedule, your list in order', window: { anchor: 'contactOpens', startDays: -21, dueDays: 0 } },
    { id: 'unofficial-visits', grade: 11, title: 'Plan unofficial visits to top targets', detail: 'Log every visit and conversation', window: { anchor: 'contactOpens', startDays: 0, dueDays: 120 }, action: { type: 'open', target: 'coaches' } },
  ].map((item) => ({ appliesTo: { sports: null, divisions: null, positions: null }, proOnly: false, ...item })),
};

export const plans = {
  free: { viewOnly: true, maxTargets: 0, maxPlayers: 0, aiDraftsPerMonth: 0, scheduleImport: false, overlapAlerts: false, expenses: false },
  pro: { viewOnly: false, maxTargets: 500, maxPlayers: 1, aiDraftsPerMonth: 60, scheduleImport: true, overlapAlerts: true, cardViewTracking: true, expenses: true },
  prices: { proYearUsd: 500, proMonthUsd: 49, siblingYearUsd: 99 },
};

async function main() {
  const batch = db.batch();
  batch.set(db.doc('config/ncaaRules'), ncaaRules);
  batch.set(db.doc('config/checklist'), checklist);
  batch.set(db.doc('config/plans'), plans);
  await batch.commit();
  console.log(`Seeded config/ncaaRules, config/checklist (${checklist.items.length} items), config/plans in ${projectId}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
