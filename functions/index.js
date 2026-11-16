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
const { validatePlayer, ValidationError } = require('./lib/player');

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

/**
 * Change a family's entitlement. Claims are updated FIRST, then the family doc:
 * the app refreshes its token when it sees the doc change, so the new claims must
 * already be in place by then.
 */
async function applyEntitlement(fid, entitlement, extra = {}) {
  const famRef = db.doc(`families/${fid}`);
  const fam = await famRef.get();
  if (!fam.exists) return;
  const pro = isProEntitlement(entitlement);
  await Promise.all((fam.get('memberUids') || []).map(
    (uid) => admin.auth().setCustomUserClaims(uid, { fid, pro })));
  await famRef.update({ entitlement, ...extra });
}

/** 10-character invite code without look-alike characters. */
function newInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let code = '';
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

/** Display name for the family members list: the account name, else the email's first part. */
function memberName(token) {
  if (token.name) return String(token.name).slice(0, 80);
  if (token.email) return String(token.email).split('@')[0].slice(0, 80);
  return 'Member';
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
      members: { [uid]: { name: memberName(token), role: 'parent' } },
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

    tx.update(targetRef, {
      memberUids: FieldValue.arrayUnion(uid),
      [`members.${uid}`]: { name: memberName(token), role: invite.role },
    });
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

/**
 * updateMyName — set your display name on your user doc and in your family's members list.
 * data: { name }
 */
exports.updateMyName = onCall(async (req) => {
  const uid = requireAuth(req);
  const name = cleanName(req.data && req.data.name, '');
  if (!name) throw new HttpsError('invalid-argument', 'Enter your name.');
  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError('failed-precondition', 'Set up your family first.');
  const fid = userSnap.get('familyId');
  const batch = db.batch();
  batch.update(userRef, { displayName: name });
  if (fid) batch.update(db.doc(`families/${fid}`), { [`members.${uid}.name`]: name });
  await batch.commit();
  return { name };
});

/** Random lowercase id, e.g. for card slugs. */
function randomId(len = 8) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** The caller's family id, read from their user doc (tokens can lag right after setup). */
async function familyIdOf(uid) {
  const user = await db.doc(`users/${uid}`).get();
  const fid = user.exists ? user.get('familyId') : null;
  if (!fid) throw new HttpsError('failed-precondition', 'Set up your family first.');
  return fid;
}

/** Look up the caller's family and require an active Pro entitlement. */
async function requireProFamily(req) {
  const uid = requireAuth(req);
  const fid = await familyIdOf(uid);
  const fam = await db.doc(`families/${fid}`).get();
  if (!fam.exists) throw new HttpsError('failed-precondition', 'Set up your family first.');
  if (!isProEntitlement(fam.get('entitlement'))) {
    throw new HttpsError('permission-denied', 'Saving your own information needs LaxHQ Pro.');
  }
  return { uid, fid, family: fam };
}

function toHttpsError(e) {
  if (e instanceof ValidationError) return new HttpsError('invalid-argument', e.message, { field: e.field });
  return e;
}

/**
 * addPlayer — create a player in the caller's Pro family.
 * Enforces entitlement.maxPlayers (1 + sibling add-ons).
 * data: player profile (see lib/player.js)
 */
exports.addPlayer = onCall(async (req) => {
  const { uid, fid } = await requireProFamily(req);
  let clean;
  try { clean = validatePlayer(req.data || {}); } catch (e) { throw toHttpsError(e); }

  const famRef = db.doc(`families/${fid}`);
  const playerRef = famRef.collection('players').doc();
  await db.runTransaction(async (tx) => {
    const fam = await tx.get(famRef);
    const max = fam.get('entitlement.maxPlayers') || 0;
    const count = fam.get('playerCount') || 0;
    if (count >= max) {
      throw new HttpsError('resource-exhausted', max <= 1
        ? 'Add a sibling to your plan to create another player.'
        : `Your plan covers ${max} players.`);
    }
    tx.set(playerRef, {
      ...clean,
      teamIds: [],
      targetCount: 0,
      cardSlug: randomId(8),
      cardPublished: false,
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(playerRef.collection('checklist').doc('state'), { templateVersion: 1, done: {}, skipped: {}, custom: {} });
    tx.update(famRef, { playerCount: FieldValue.increment(1) });
  });
  return { playerId: playerRef.id };
});

/**
 * updatePlayer — edit a player's profile (only the fields sent).
 * data: { playerId, ...fields }
 */
exports.updatePlayer = onCall(async (req) => {
  const { fid } = await requireProFamily(req);
  const { playerId, ...fields } = req.data || {};
  if (typeof playerId !== 'string' || !playerId) throw new HttpsError('invalid-argument', 'playerId is required.');
  if (Object.prototype.hasOwnProperty.call(fields, 'cardPublished')) {
    fields.cardPublished = Boolean(fields.cardPublished);
  }
  const { cardPublished, ...profile } = fields;
  let clean;
  try { clean = validatePlayer(profile, { partial: true }); } catch (e) { throw toHttpsError(e); }
  if (cardPublished !== undefined) clean.cardPublished = cardPublished;
  if (!Object.keys(clean).length) throw new HttpsError('invalid-argument', 'Nothing to update.');

  const ref = db.doc(`families/${fid}/players/${playerId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That player was not found.');
  await ref.update({ ...clean, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

/**
 * devSetPlan — EMULATOR ONLY. Switch the caller's family between free and Pro
 * so every Pro screen can be tested before Stripe is connected.
 * data: { plan: 'free' | 'pro', maxPlayers? }
 */
exports.devSetPlan = onCall(async (req) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') throw new HttpsError('permission-denied', 'Not available.');
  const fid = await familyIdOf(requireAuth(req));
  const pro = req.data && req.data.plan === 'pro';
  await applyEntitlement(fid, pro
    ? { plan: 'pro', source: 'dev', interval: 'year', status: 'active', currentPeriodEnd: null,
      maxPlayers: Math.min(Math.max(Number(req.data.maxPlayers) || 1, 1), 6), orgId: null }
    : { ...FREE_ENTITLEMENT });
  return { plan: pro ? 'pro' : 'free' };
});

/** refreshMyClaims — re-read the family's entitlement and update this user's claims. */
exports.refreshMyClaims = onCall(async (req) => {
  const uid = requireAuth(req);
  const userSnap = await db.doc(`users/${uid}`).get();
  return { claims: await setClaims(uid, userSnap.get('familyId') || null) };
});

// ---------- recruiting card (Phase 3) ----------
const card = require('./card');

exports.onPlayerWrite = card.onPlayerWrite;
exports.cardView = card.cardView;

// ---------- coach outreach (Phase 4) ----------
const coaches = require('./coaches');

coaches.init({ requireProFamily, requireAuth });
exports.contactCardLink = coaches.contactCardLink;
exports.aiDraftEmail = coaches.aiDraftEmail;
exports.onContactWrite = coaches.onContactWrite;
exports.reportCoach = coaches.reportCoach;
exports.reportOutcome = coaches.reportOutcome;
exports.dailyNudges = coaches.dailyNudges;
exports.devRunNudges = coaches.devRunNudges;
