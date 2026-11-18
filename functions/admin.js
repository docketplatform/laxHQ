// Platform admin (the site owner) and highlight-reel requests.
//
// admins/{uid}                 server-written; the user can read their own doc (shows the Admin area).
//                              Set with scripts/platform-admin.mjs (Actions → Platform admin).
// config/highlights            the highlight partner shown to every family; edited in the Admin area.
// highlightRequests/{id}       one per "Request a reel"; the family can read its own, admins read all.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const db = getFirestore();
let helpers = null;
function init(h) { helpers = h; }

async function requireAdmin(req) {
  const uid = helpers.requireAuth(req);
  const snap = await db.doc(`admins/${uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Admins only.');
  return uid;
}

const iso = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v || null);

/** adminOverview — every account, family and player, plus highlight requests. Read-only. */
const adminOverview = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (req) => {
  await requireAdmin(req);
  const accounts = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const u of page.users) {
      accounts.push({
        uid: u.uid, email: u.email || null, name: u.displayName || null,
        createdAt: u.metadata.creationTime ? new Date(u.metadata.creationTime).toISOString() : null,
        lastSignInAt: u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime).toISOString() : null,
      });
    }
    pageToken = page.pageToken;
  } while (pageToken && accounts.length < 10000);

  const [famSnap, playerSnap, userSnap, reqSnap] = await Promise.all([
    db.collection('families').get(),
    db.collectionGroup('players').get(),
    db.collection('users').get(),
    db.collection('highlightRequests').orderBy('createdAt', 'desc').limit(300).get(),
  ]);
  const familyOfUser = Object.fromEntries(userSnap.docs.map((d) => [d.id, d.get('familyId') || null]));
  const players = {};
  for (const p of playerSnap.docs) {
    const fid = p.ref.parent.parent?.id;
    if (!fid || p.ref.parent.parent.parent.id !== 'families') continue;
    const d = p.data();
    (players[fid] ||= []).push({
      id: p.id, firstName: d.firstName || '', lastName: d.lastName || '', gradYear: d.gradYear || null,
      sport: d.sport || null, position: d.position || null, club: d.club?.name || null,
      highSchool: d.highSchool?.name || null, targetCount: d.targetCount || 0,
      cardPublished: Boolean(d.cardPublished), hasFilm: Boolean(d.filmUrl || (d.videos || []).length),
    });
  }
  const byUid = Object.fromEntries(accounts.map((a) => [a.uid, a]));
  const families = famSnap.docs.map((f) => {
    const d = f.data();
    const ent = d.entitlement || {};
    return {
      id: f.id, name: d.name || '', createdAt: iso(d.createdAt),
      plan: ent.plan || 'free', source: ent.source || null, status: ent.status || null, maxPlayers: ent.maxPlayers || 0,
      members: (d.memberUids || []).map((uid) => ({
        uid, name: d.members?.[uid]?.name || byUid[uid]?.name || null, role: d.members?.[uid]?.role || null,
        email: byUid[uid]?.email || null, lastSignInAt: byUid[uid]?.lastSignInAt || null, owner: uid === d.ownerUid,
      })),
      players: players[f.id] || [],
    };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const requests = reqSnap.docs.map((r) => ({ id: r.id, ...r.data(), createdAt: iso(r.get('createdAt')) }));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      accounts: accounts.length,
      families: families.length,
      proFamilies: families.filter((f) => f.plan === 'pro').length,
      players: Object.values(players).reduce((n, l) => n + l.length, 0),
      highlightRequests: requests.length,
    },
    families,
    accountsWithoutFamily: accounts.filter((a) => !familyOfUser[a.uid]),
    requests,
  };
});

// ---------- highlight partner ----------

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const longStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const url = (v) => { const s = str(v, 300); if (!s) return null; if (!/^https?:\/\//i.test(s)) throw new HttpsError('invalid-argument', 'Links must start with https://'); return s; };

/** adminSaveHighlightPartner — the partner every family sees on the Highlights tab. */
const adminSaveHighlightPartner = onCall(async (req) => {
  const uid = await requireAdmin(req);
  const d = req.data || {};
  const email = str(d.email, 120).toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpsError('invalid-argument', 'That email doesn’t look right.');
  const partner = {
    active: Boolean(d.active),
    name: str(d.name, 80),
    business: str(d.business, 80),
    tagline: str(d.tagline, 140),
    about: longStr(d.about, 1500),
    priceFrom: str(d.priceFrom, 60),
    turnaround: str(d.turnaround, 60),
    includes: longStr(d.includes, 800),
    email: email || null,
    phone: str(d.phone, 30) || null,
    website: url(d.website),
    sampleUrl: url(d.sampleUrl),
    familyOffer: str(d.familyOffer, 140),
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
  };
  if (partner.active && (!partner.name || (!partner.email && !partner.phone))) {
    throw new HttpsError('invalid-argument', 'Add a name and an email or phone before showing the partner to families.');
  }
  await db.doc('config/highlights').set(partner);
  return { ok: true };
});

/**
 * requestHighlights — a family asks the partner for a reel. Logs the request (so the owner can
 * see demand and follow up) and returns what the app needs to open an email to the partner.
 * Any signed-in family can ask; it doesn't store player information beyond a summary.
 * data: { playerId?, filmLinks, neededBy?, message?, phone? }
 */
const requestHighlights = onCall(async (req) => {
  const uid = helpers.requireAuth(req);
  const user = await db.doc(`users/${uid}`).get();
  const fid = user.get('familyId');
  if (!fid) throw new HttpsError('failed-precondition', 'Finish setting up your family first.');
  const partner = (await db.doc('config/highlights').get()).data();
  if (!partner?.active) throw new HttpsError('failed-precondition', 'Highlight reels aren’t available yet.');

  const since = Timestamp.fromDate(new Date(Date.now() - 86400000));
  const recent = await db.collection('highlightRequests').where('fid', '==', fid).where('createdAt', '>', since).count().get();
  if (recent.data().count >= 5) throw new HttpsError('resource-exhausted', 'You’ve sent several requests today. The partner will be in touch.');

  const d = req.data || {};
  let player = null;
  if (typeof d.playerId === 'string' && d.playerId) {
    const p = await db.doc(`families/${fid}/players/${d.playerId}`).get();
    if (p.exists) {
      const pd = p.data();
      player = { id: p.id, name: `${pd.firstName || ''} ${pd.lastName || ''}`.trim(), gradYear: pd.gradYear || null, position: pd.position || null, sport: pd.sport || null, club: pd.club?.name || null, highSchool: pd.highSchool?.name || null };
    }
  }
  const fam = await db.doc(`families/${fid}`).get();
  const request = {
    fid, uid, familyName: fam.get('name') || null,
    parentName: fam.get(`members.${uid}.name`) || req.auth.token.name || null,
    email: req.auth.token.email || user.get('email') || null,
    phone: str(d.phone, 30) || null,
    player,
    filmLinks: longStr(d.filmLinks, 1500),
    neededBy: str(d.neededBy, 40) || null,
    message: longStr(d.message, 1500),
    partnerName: partner.name,
    status: 'new',
    createdAt: FieldValue.serverTimestamp(),
  };
  const ref = await db.collection('highlightRequests').add(request);
  return { id: ref.id };
});

/** adminUpdateHighlightRequest — mark a request contacted / booked / done / closed. */
const adminUpdateHighlightRequest = onCall(async (req) => {
  await requireAdmin(req);
  const { id, status } = req.data || {};
  if (typeof id !== 'string' || !['new', 'contacted', 'booked', 'done', 'closed'].includes(status)) throw new HttpsError('invalid-argument', 'Bad request.');
  await db.doc(`highlightRequests/${id}`).update({ status, statusAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

module.exports = { init, adminOverview, adminSaveHighlightPartner, requestHighlights, adminUpdateHighlightRequest };
