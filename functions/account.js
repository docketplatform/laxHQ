// Account deletion and backups (Phase 7).
//
// deleteAccount { scope: 'me' | 'family' }
//   'me'      – you leave: your login, user record and place in the family are removed.
//               If you were the last member, the whole family is deleted (as 'family').
//               If you owned the family, ownership passes to another parent.
//   'family'  – owner only: deletes the family and everything in it (players, plans, coaches,
//               expenses, receipts, cards, schedule links), cancels the Stripe subscription,
//               and unlinks the other members (they start fresh next time they sign in).

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const db = getFirestore();
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

let helpers = null;
function init(h) { helpers = h; }

async function deleteFamilyData(fid, { stripeClient } = {}) {
  const famRef = db.doc(`families/${fid}`);
  const fam = await famRef.get();
  if (!fam.exists) return;
  const players = await famRef.collection('players').get();

  // Public and server-only records outside the family tree.
  for (const p of players.docs) {
    const slug = p.get('cardSlug');
    if (slug) {
      await db.recursiveDelete(db.doc(`cardViews/${slug}`)).catch(() => {});
      await Promise.all([db.doc(`cards/${slug}`).delete(), db.doc(`cardSlugs/${slug}`).delete(), db.doc(`cardCounts/${slug}`).delete()]);
    }
    const tokens = await db.collection('cardTokens').where('pid', '==', p.id).get();
    await Promise.all(tokens.docs.filter((t) => t.get('fid') === fid).map((t) => t.ref.delete()));
    await db.doc(`outcomes/${fid}_${p.id}`).delete();
  }
  const feeds = await db.collection('feeds').where('fid', '==', fid).get();
  for (const f of feeds.docs) {
    for (const tid of f.get('teamIds') || []) {
      await db.doc(`teams/${tid}`).update({ memberFids: FieldValue.arrayRemove(fid), feedIds: FieldValue.arrayRemove(f.id) }).catch(() => {});
    }
    await f.ref.delete();
  }
  const invites = await db.collection('invites').where('fid', '==', fid).get();
  await Promise.all(invites.docs.map((d) => d.ref.delete()));
  const usage = await db.collection('usage').where('fid', '==', fid).get();
  await Promise.all(usage.docs.map((d) => d.ref.delete()));
  await getStorage().bucket().deleteFiles({ prefix: `receipts/${fid}/` }).catch(() => {});

  // Billing: cancel the web subscription and remove the customer.
  const customer = fam.get('stripeCustomerId');
  if (customer && stripeClient) {
    await stripeClient.customers.del(customer).catch((e) => console.warn('stripe delete customer', e.message));
  }

  // Everyone in the family is unlinked.
  for (const uid of fam.get('memberUids') || []) {
    await db.doc(`users/${uid}`).set({ familyId: null }, { merge: true }).catch(() => {});
    await admin.auth().setCustomUserClaims(uid, { fid: null, pro: false }).catch(() => {});
  }
  await db.recursiveDelete(famRef);
}

const deleteAccount = onCall({ secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 300 }, async (req) => {
  const uid = helpers.requireAuth(req);
  const scope = req.data?.scope === 'family' ? 'family' : 'me';
  const user = await db.doc(`users/${uid}`).get();
  const fid = user.exists ? user.get('familyId') : null;
  const fam = fid ? await db.doc(`families/${fid}`).get() : null;
  const members = fam?.exists ? (fam.get('memberUids') || []) : [];
  const isOwner = fam?.exists && fam.get('ownerUid') === uid;
  let stripeClient = null;
  try { stripeClient = helpers.stripeClient(); } catch { stripeClient = null; }

  if (fam?.exists && (scope === 'family' || members.length <= 1)) {
    if (scope === 'family' && !isOwner) throw new HttpsError('permission-denied', 'Only the parent who set up the family can delete it.');
    await deleteFamilyData(fid, { stripeClient });
  } else if (fam?.exists) {
    const others = members.filter((m) => m !== uid);
    const update = { memberUids: FieldValue.arrayRemove(uid), [`members.${uid}`]: FieldValue.delete() };
    if (isOwner) {
      const nextParent = others.find((m) => fam.get(`members.${m}.role`) !== 'player') || others[0];
      update.ownerUid = nextParent;
    }
    await db.doc(`families/${fid}`).update(update);
  }
  await db.doc(`users/${uid}`).delete();
  await admin.auth().deleteUser(uid).catch((e) => { if (e.code !== 'auth/user-not-found') throw e; });
  return { deleted: scope === 'family' || members.length <= 1 ? 'family' : 'me' };
});

/**
 * Daily Firestore export to gs://$BACKUP_BUCKET (set BACKUP_BUCKET in functions/.env.<project>, and give the default service
 * account the "Cloud Datastore Import Export Admin" role and write access to the bucket).
 * Add a lifecycle rule on the bucket to delete exports after 30 days.
 */
const backupFirestore = onSchedule({ schedule: 'every day 03:30', timeZone: 'America/New_York' }, async () => {
  const bucket = process.env.BACKUP_BUCKET;
  if (!bucket) { console.warn('backupFirestore: BACKUP_BUCKET is not set; skipping'); return; }
  const { v1 } = require('@google-cloud/firestore');
  const client = new v1.FirestoreAdminClient();
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  const [op] = await client.exportDocuments({
    name: client.databasePath(projectId, '(default)'),
    outputUriPrefix: `gs://${bucket}/firestore/${new Date().toISOString().slice(0, 10)}`,
    collectionIds: [],
  });
  console.log('backupFirestore started', op.name);
});

module.exports = { init, deleteAccount, backupFirestore, deleteFamilyData };
