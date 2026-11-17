// Seeds schools/{id} and the compact search index catalog/index from data/schools.json.
// Re-running keeps any academics already imported (merge).
//
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-schools.mjs
//   GOOGLE_APPLICATION_CREDENTIALS=key.json GCLOUD_PROJECT=laxhq-ce7b7 node scripts/seed-schools.mjs
import { readFileSync } from 'node:fs';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { defaultAthleticTier } from '../web/lib/fit.js';

/** Program fields with a default athletic tier (an estimate the family can override per target). */
export function withTiers(school) {
  const programs = {};
  for (const [sport, p] of Object.entries(school.programs || {})) {
    programs[sport] = { ...p, athleticTier: p.athleticTier ?? defaultAthleticTier(p.division, p.conference) };
  }
  return { ...school, programs };
}

/** Compact index row: [id, name, city, state, mlaxDivision, wlaxDivision, mlaxConference, wlaxConference]. */
export function indexRow(s) {
  return [s.id, s.name, s.city || '', s.state || '', s.programs?.mlax?.division || '', s.programs?.wlax?.division || '',
    s.programs?.mlax?.conference || '', s.programs?.wlax?.conference || ''];
}

export async function seedSchools(db, schools) {
  const rows = [];
  for (let i = 0; i < schools.length; i += 400) {
    const batch = db.batch();
    for (const raw of schools.slice(i, i + 400)) {
      const s = withTiers(raw);
      const { id, ...data } = s;
      batch.set(db.doc(`schools/${id}`), { ...data, updatedAt: new Date() }, { merge: true });
      rows.push(indexRow(s));
    }
    await batch.commit();
  }
  rows.sort((a, b) => a[1].localeCompare(b[1]));
  await db.doc('catalog/index').set({ version: Date.now(), count: rows.length, rows: rows.map((r) => r.join('|')) });
  return rows.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-laxhq' });
  const { schools } = JSON.parse(readFileSync(new URL('../data/schools.json', import.meta.url)));
  seedSchools(getFirestore(), schools)
    .then((n) => console.log(`Seeded ${n} schools and catalog/index`))
    .catch((e) => { console.error(e); process.exit(1); });
}
