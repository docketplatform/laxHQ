// Brings every live recruiting card's name fields up to date with the current rules
// (run by the deploy; safe to repeat). Cards are otherwise rebuilt only when a player changes.
//
//   GCLOUD_PROJECT=laxhq-ce7b7 node scripts/refresh-cards.mjs
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/', import.meta.url));
const { initializeApp, getApps } = require('firebase-admin/app');
if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-laxhq' });
const { getFirestore } = require('firebase-admin/firestore');
const { cardName } = require('./card.js');

const db = getFirestore();
let n = 0;
for (const s of (await db.collection('cardSlugs').get()).docs) {
  const { fid, pid } = s.data();
  const [card, player] = await Promise.all([db.doc(`cards/${s.id}`).get(), db.doc(`families/${fid}/players/${pid}`).get()]);
  if (!card.exists || !player.exists) continue;
  const want = cardName(player.data());
  if (Object.entries(want).some(([k, v]) => card.get(k) !== v)) { await card.ref.update(want); n += 1; }
}
console.log(`Refreshed the name on ${n} card(s).`);
