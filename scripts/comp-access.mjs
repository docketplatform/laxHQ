// Gives (or removes) complimentary Pro for one family, with no Stripe charge.
// Used for the owner's own test account and for friends/reviewers.
//
//   COMP_EMAIL=parent@example.com COMP_PLAYERS=2 GCLOUD_PROJECT=laxhq-ce7b7 node scripts/comp-access.mjs grant
//   COMP_EMAIL=parent@example.com GCLOUD_PROJECT=laxhq-ce7b7 node scripts/comp-access.mjs revoke
//
// Run it from GitHub: Actions → "Complimentary Pro" → Run workflow.
// The person must have signed in to the app once first.
//
// It writes families/{fid}/billing/org (the same source a club or advisor seat uses), so any later
// Stripe or App Store change is combined with it instead of overwriting it.

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

const projectId = process.env.GCLOUD_PROJECT || 'demo-laxhq';
initializeApp({ projectId });
const db = getFirestore();
const auth = getAuth();

const mode = process.argv[2];
const email = String(process.env.COMP_EMAIL || '').trim().toLowerCase();
const players = Math.min(Math.max(Number(process.env.COMP_PLAYERS) || 1, 1), 6);
const days = Math.min(Math.max(Number(process.env.COMP_DAYS) || 365, 1), 3650);

function fail(msg) { console.error(`::error::${msg}`); process.exit(1); }

async function main() {
  if (!['grant', 'revoke'].includes(mode)) fail('Say grant or revoke.');
  if (!email.includes('@')) fail('COMP_EMAIL is not an email address.');

  let user;
  try { user = await auth.getUserByEmail(email); } catch {
    fail('No LaxHQ login uses that email yet. Sign in to the app once with it, then run this again.');
  }
  const userDoc = await db.doc(`users/${user.uid}`).get();
  const fid = userDoc.exists ? userDoc.get('familyId') : null;
  if (!fid) fail('That login has no family yet. Open the app once after signing in, then run this again.');

  const famRef = db.doc(`families/${fid}`);
  const orgRef = famRef.collection('billing').doc('org');
  if (mode === 'grant') {
    const expiresAt = Timestamp.fromDate(new Date(Date.now() + days * 86400000));
    await orgRef.set({ active: true, orgId: 'comp', maxPlayers: players, expiresAt, grantedAt: FieldValue.serverTimestamp() });
  } else {
    await orgRef.set({ active: false, revokedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  // Recompute the entitlement from every billing source (same rules as functions/billing.js).
  const now = new Date();
  const docs = Object.fromEntries((await famRef.collection('billing').get()).docs.map((d) => [d.id, d.data()]));
  const toDate = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);
  const live = (s) => s && s.active && (!s.expiresAt || toDate(s.expiresAt) > now);
  const choices = [];
  const { stripe: st, revenuecat: rc, org } = docs;
  if (live(st)) choices.push({ source: 'stripe', status: st.status === 'past_due' ? 'past_due' : 'active', interval: st.interval || null, currentPeriodEnd: toDate(st.currentPeriodEnd), maxPlayers: st.maxPlayers || 1, orgId: null });
  if (live(rc)) choices.push({ source: 'revenuecat', status: rc.billingIssue ? 'past_due' : 'active', interval: rc.interval || 'year', currentPeriodEnd: toDate(rc.expiresAt), maxPlayers: rc.maxPlayers || 1, orgId: null });
  if (live(org)) choices.push({ source: 'org', status: 'active', interval: null, currentPeriodEnd: null, maxPlayers: org.maxPlayers || 1, orgId: org.orgId || null });
  let ent = { plan: 'free', source: null, interval: null, status: null, currentPeriodEnd: null, maxPlayers: 0, orgId: null };
  if (choices.length) {
    choices.sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.maxPlayers - a.maxPlayers);
    ent = { plan: 'pro', ...choices[0], maxPlayers: Math.max(...choices.map((c) => c.maxPlayers)) };
  }

  // Claims first, then the family doc (the app refreshes its login when the doc changes).
  const fam = await famRef.get();
  const pro = ent.plan === 'pro';
  await Promise.all((fam.get('memberUids') || []).map((uid) => auth.setCustomUserClaims(uid, { fid, pro })));
  await famRef.update({ entitlement: ent });
  console.log(mode === 'grant'
    ? `Pro is on for that family: up to ${players} player(s), for ${days} days.`
    : `Complimentary Pro removed. The family is now on ${ent.plan === 'pro' ? `Pro through ${ent.source}` : 'the free plan'}.`);
}

main().catch((e) => fail(e.message));
