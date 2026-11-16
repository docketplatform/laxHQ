// LaxHQ Cloud Functions — Phase 0: family setup, invites and custom claims.
//
// Claims on every member's ID token:
//   fid — the family the user belongs to (security rules check it with no reads)
//   pro — true while the family's entitlement is an active Pro plan
//
// After any call that changes claims, the client calls getIdToken(true)
// so the new claims take effect immediately.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const crypto = require('node:crypto');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const db = getFirestore();

const INVITE_TTL_DAYS = 7;
const MAX_OPEN_INVITES = 10;
const FREE_ENTITLEMENT = Object.freeze({
  plan: 'free', source: null, interval: null, status: null,
  currentPeriodEnd: null, maxPlayers: 0, orgId: null,
});

// ---------- helpers ----------

function requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  return req.auth.uid;
}

/** Pro is active when the plan is pro and the status is active (or past_due during Stripe's retry window). */
function isProEntitlement(ent) {
  return !!ent && ent.plan === 'pro' && ['active', 'past_due'].includes(ent.status);
}

/** Set { fid, pro } claims for one user from their family's entitlement. */
async function setClaims(uid, fid) {
  let pro = false;
  if (fid) {
    const fam = await db.doc(`families/${fid}`).get();
    pro = isProEntitlement(fam.get('entitlement'));
  }
  await admin.auth().setCustomUserClaims(uid, { fid: fid || null, pro });
  return { fid: fid || null, pro };
}

/** Re-apply claims to every member of a family (used when the entitlement changes). */
async function refreshFamilyClaims(fid) {
  const fam = await db.doc(`families/${fid}`).get();
  if (!fam.exists) return;
  const pro = isProEntitlement(fam.get('entitlement'));
  await Promise.all((fam.get('memberUids') || []).map(
    (uid) => admin.auth().setCustomUserClaims(uid, { fid, pro })));
}

/** 10-character invite code without look-alike characters. */
function newInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let code = '';
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

function cleanName(value, fallback) {
  const s = (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

// ---------- callables ----------

/**
 * bootstrapFamily — first sign-in. Creates an empty family (no player until Pro)
 * and the user doc, then sets claims. Safe to call repeatedly.
 * data: { familyName? }
 */
exports.bootstrapFamily = onCall(async (req) => {
  const uid = requireAuth(req);
  const userRef = db.doc(`users/${uid}`);
  const token = req.auth.token || {};

  const result = await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const existing = userSnap.exists ? userSnap.get('familyId') : null;
    if (existing) return { familyId: existing, created: false };

    const famRef = db.collection('families').doc();
    const fallbackName = token.name ? `${String(token.name).split(' ').slice(-1)[0]} family` : 'My family';
    tx.set(famRef, {
      name: cleanName(req.data && req.data.familyName, fallbackName),
      memberUids: [uid],
      ownerUid: uid,
      playerCount: 0,
      entitlement: { ...FREE_ENTITLEMENT },
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(userRef, {
      displayName: token.name || null,
      email: token.email || null,
      familyId: famRef.id,
      role: 'parent',
      notify: { email: true, push: false, weeklyDigest: true },
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { familyId: famRef.id, created: true };
  });

  const claims = await setClaims(uid, result.familyId);
  return { ...result, claims };
});

/**
 * createInvite — a family member invites a co-parent or the player.
 * data: { role: 'parent' | 'player' }
 * returns: { code, expiresAt }
 */
exports.createInvite = onCall(async (req) => {
  const uid = requireAuth(req);
  const role = req.data && req.data.role;
  if (!['parent', 'player'].includes(role)) {
    throw new HttpsError('invalid-argument', 'role must be "parent" or "player".');
  }
  const userSnap = await db.doc(`users/${uid}`).get();
  const fid = userSnap.get('familyId');
  if (!fid) throw new HttpsError('failed-precondition', 'Set up your family first.');

  const open = await db.collection('invites')
    .where('fid', '==', fid).where('usedBy', '==', null)
    .where('expiresAt', '>', Timestamp.now()).count().get();
  if (open.data().count >= MAX_OPEN_INVITES) {
    throw new HttpsError('resource-exhausted', 'Too many open invites. Use or let one expire first.');
  }

  const expiresAt = Timestamp.fromMillis(Date.now() + INVITE_TTL_DAYS * 864e5);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newInviteCode();
    try {
      await db.doc(`invites/${code}`).create({
        fid, role, createdBy: uid, createdAt: FieldValue.serverTimestamp(), expiresAt, usedBy: null,
      });
      return { code, expiresAt: expiresAt.toMillis() };
    } catch (e) {
      if (e.code !== 6) throw e; // 6 = ALREADY_EXISTS → try another code
    }
  }
  throw new HttpsError('internal', 'Could not create an invite. Try again.');
});

/**
 * acceptInvite — join a family from an invite link.
 * A user who already belongs to a family with other members can't switch.
 * A user whose only family is an empty one they created alone is moved,
 * and that empty family is deleted.
 * data: { code }
 */
exports.acceptInvite = onCall(async (req) => {
  const uid = requireAuth(req);
  const code = String((req.data && req.data.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 10) throw new HttpsError('invalid-argument', 'That invite code is not valid.');

  const inviteRef = db.doc(`invites/${code}`);
  const userRef = db.doc(`users/${uid}`);
  const token = req.auth.token || {};

  const fid = await db.runTransaction(async (tx) => {
    const [inviteSnap, userSnap] = await Promise.all([tx.get(inviteRef), tx.get(userRef)]);
    if (!inviteSnap.exists) throw new HttpsError('not-found', 'That invite was not found.');
    const invite = inviteSnap.data();
    if (invite.usedBy) throw new HttpsError('failed-precondition', 'That invite has already been used.');
    if (invite.expiresAt.toMillis() < Date.now()) throw new HttpsError('deadline-exceeded', 'That invite has expired.');

    const targetRef = db.doc(`families/${invite.fid}`);
    const targetSnap = await tx.get(targetRef);
    if (!targetSnap.exists) throw new HttpsError('not-found', 'That family no longer exists.');

    const current = userSnap.exists ? userSnap.get('familyId') : null;
    if (current === invite.fid) return invite.fid; // already a member: nothing to do
    if (current) {
      const curRef = db.doc(`families/${current}`);
      const curSnap = await tx.get(curRef);
      const members = curSnap.exists ? (curSnap.get('memberUids') || []) : [];
      const lonelyEmpty = members.length <= 1 && (curSnap.get('playerCount') || 0) === 0
        && !isProEntitlement(curSnap.get('entitlement'));
      if (!lonelyEmpty) {
        throw new HttpsError('failed-precondition', 'You already belong to another family.');
      }
      tx.delete(curRef);
    }

    tx.update(targetRef, { memberUids: FieldValue.arrayUnion(uid) });
    tx.set(userRef, {
      displayName: token.name || null,
      email: token.email || null,
      familyId: invite.fid,
      role: invite.role,
      notify: { email: true, push: false, weeklyDigest: true },
      createdAt: userSnap.exists ? userSnap.get('createdAt') : FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.update(inviteRef, { usedBy: uid, usedAt: FieldValue.serverTimestamp() });
    return invite.fid;
  });

  const claims = await setClaims(uid, fid);
  return { familyId: fid, claims };
});

/** refreshMyClaims — re-read the family's entitlement and update this user's claims. */
exports.refreshMyClaims = onCall(async (req) => {
  const uid = requireAuth(req);
  const userSnap = await db.doc(`users/${uid}`).get();
  return { claims: await setClaims(uid, userSnap.get('familyId') || null) };
});

// refreshFamilyClaims is used by the billing webhooks in Phase 6.
void refreshFamilyClaims;
