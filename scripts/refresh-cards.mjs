// Rebuilds every live recruiting card from its player with the current card rules
// (run by the deploy; safe to repeat). Cards are otherwise rebuilt only when a player changes.
//
//   GCLOUD_PROJECT=laxhq-ce7b7 node scripts/refresh-cards.mjs
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/', import.meta.url));
const { initializeApp, getApps } = require('firebase-admin/app');
if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-laxhq' });
const { getFirestore } = require('firebase-admin/firestore');
const { buildCard, familyContactEmail } = require('./card.js');
const { cardEvents } = require('./schedule.js');

/** JSON with object keys sorted at every level, so field order doesn't matter. */
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' && !(v.toDate) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v?.toDate ? v.toDate() : v));

const db = getFirestore();
let n = 0;
for (const s of (await db.collection('cardSlugs').get()).docs) {
  const { fid, pid } = s.data();
  const [card, player] = await Promise.all([db.doc(`cards/${s.id}`).get(), db.doc(`families/${fid}/players/${pid}`).get()]);
  if (!card.exists || !player.exists) continue;
  const p = player.data();
  // Fill in "Where to see me" for players whose plan was saved before the card showed events.
  const plan = (await player.ref.collection('plan').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const events = cardEvents(plan);
  if (canon(events) !== canon(p.cardEvents || [])) { await player.ref.update({ cardEvents: events }); p.cardEvents = events; }
  if (!p.cardPublished) continue;
  const want = buildCard(p, { contactEmail: await familyContactEmail(fid), summer: p.cardSummer || [] });
  if (canon({ ...want, updatedAt: null }) !== canon({ ...card.data(), updatedAt: null })) { await card.ref.set(want); n += 1; }
}
console.log(`Rebuilt ${n} card(s).`);
