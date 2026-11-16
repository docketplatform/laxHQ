// End-to-end tests for the Phase 0 callables, run against the Auth, Firestore and
// Functions emulators: npm run test:functions
import { test, before, after, afterEach } from 'node:test';
import { startMockAnthropic } from './mock-anthropic.mjs';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signOut,
} from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, terminate,
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { initializeApp as adminInit, getApps as adminApps } from 'firebase-admin/app';
import { getFirestore as adminDb } from 'firebase-admin/firestore';

if (!adminApps().length) adminInit({ projectId: PROJECT_ID_FOR_ADMIN() });
function PROJECT_ID_FOR_ADMIN() { return 'demo-laxhq'; }
const adb = adminDb();
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 200)); } };
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const view = (slug, r, ua = CHROME, ip = '203.0.113.7') => fetch('http://127.0.0.1:5001/demo-laxhq/us-central1/cardView', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'X-Forwarded-For': ip }, body: JSON.stringify({ slug, r }),
}).then(async (res) => ({ status: res.status, ...(await res.json()) }));

const PROJECT = 'demo-laxhq';
let n = 0;
const open = new Set();

/** A fresh signed-in client with its own app instance. */
async function newClient(label) {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'demo-key', authDomain: `${PROJECT}.firebaseapp.com` }, `${label}-${n++}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const fns = getFunctions(app, 'us-central1');
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  const email = `${label}-${Date.now()}-${n}@example.com`;
  await createUserWithEmailAndPassword(auth, email, 'password123');
  const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);
  const claims = async () => (await auth.currentUser.getIdTokenResult(true)).claims;
  const close = async () => {
    if (!open.has(close)) return;
    open.delete(close);
    await terminate(db).catch(() => {}); await signOut(auth).catch(() => {}); await deleteApp(app).catch(() => {});
  };
  open.add(close);
  return { app, auth, db, call, claims, close };
}

afterEach(async () => { await Promise.all([...open].map((c) => c())); });

before(async () => {
  // Fail fast with a clear message if the emulators are not running.
  const res = await fetch('http://127.0.0.1:4400/emulators').catch(() => null);
  assert.ok(res && res.ok, 'Emulators are not running. Use: npm run test:functions');
});

test('bootstrapFamily creates a free family, sets claims, and is idempotent', async () => {
  const a = await newClient('parent');
  const first = await a.call('bootstrapFamily', { familyName: 'Morrison family' });
  assert.equal(first.created, true);
  assert.ok(first.familyId);

  const claims = await a.claims();
  assert.equal(claims.fid, first.familyId);
  assert.equal(claims.pro, false);

  const fam = await getDoc(doc(a.db, `families/${first.familyId}`));
  assert.equal(fam.get('name'), 'Morrison family');
  assert.equal(fam.get('entitlement').plan, 'free');
  assert.equal(fam.get('playerCount'), 0);

  const again = await a.call('bootstrapFamily', {});
  assert.equal(again.created, false);
  assert.equal(again.familyId, first.familyId);
  await a.close();
});

test('free family members can read their family but cannot write player data', async () => {
  const a = await newClient('viewer');
  const { familyId } = await a.call('bootstrapFamily', {});
  await a.claims();
  await assert.rejects(setDoc(doc(a.db, `families/${familyId}/expenses/e1`), { amountCents: 100, source: 'manual' }));
  const fam = await getDoc(doc(a.db, `families/${familyId}`));
  assert.ok(fam.exists());
  await a.close();
});

test('invite flow: a player joins the parent’s family and gets its claims', async () => {
  const parent = await newClient('parent');
  const { familyId } = await parent.call('bootstrapFamily', {});
  const { code } = await parent.call('createInvite', { role: 'player' });
  assert.match(code, /^[A-Z2-9]{10}$/);

  const player = await newClient('player');
  // The player signed in first and got their own empty family; joining moves them.
  const own = await player.call('bootstrapFamily', {});
  assert.notEqual(own.familyId, familyId);

  const joined = await player.call('acceptInvite', { code: code.toLowerCase() });
  assert.equal(joined.familyId, familyId);
  assert.equal((await player.claims()).fid, familyId);

  const fam = await getDoc(doc(player.db, `families/${familyId}`));
  assert.deepEqual([...fam.get('memberUids')].sort(), [parent.auth.currentUser.uid, player.auth.currentUser.uid].sort());
  assert.equal(fam.get('members')[player.auth.currentUser.uid].role, 'player');
  const me = await getDoc(doc(player.db, `users/${player.auth.currentUser.uid}`));
  assert.equal(me.get('role'), 'player');

  // The empty family the player created alone is gone (read as the parent would fail anyway; check via 2nd bootstrap).
  const again = await player.call('bootstrapFamily', {});
  assert.equal(again.familyId, familyId);

  // A used invite can't be reused.
  const third = await newClient('stranger');
  await assert.rejects(third.call('acceptInvite', { code }), /already been used/);

  await Promise.all([parent.close(), player.close(), third.close()]);
});

test('someone already in a family with other members cannot be pulled into another', async () => {
  const p1 = await newClient('p1');
  const { familyId: f1 } = await p1.call('bootstrapFamily', {});
  const { code: c1 } = await p1.call('createInvite', { role: 'parent' });
  const p2 = await newClient('p2');
  await p2.call('acceptInvite', { code: c1 });

  const other = await newClient('other');
  await other.call('bootstrapFamily', {});
  const { code: c2 } = await other.call('createInvite', { role: 'parent' });
  await assert.rejects(p2.call('acceptInvite', { code: c2 }), /already belong to another family/);
  assert.equal((await p2.claims()).fid, f1);

  await Promise.all([p1.close(), p2.close(), other.close()]);
});

test('bad input and signed-out calls are rejected', async () => {
  const a = await newClient('checker');
  await a.call('bootstrapFamily', {});
  await assert.rejects(a.call('createInvite', { role: 'coach' }), /role must be/);
  await assert.rejects(a.call('acceptInvite', { code: 'nope' }), /not valid/);
  await assert.rejects(a.call('acceptInvite', { code: 'ZZZZZZZZZZ' }), /not found/);
  await signOut(a.auth);
  await assert.rejects(a.call('bootstrapFamily', {}), /Sign in first/);
  await a.close();
});

test('updateMyName updates the user doc and the family members list', async () => {
  const a = await newClient('namer');
  const { familyId } = await a.call('bootstrapFamily', {});
  await a.call('updateMyName', { name: '  Pat   Morrison ' });
  await a.claims();
  const fam = await getDoc(doc(a.db, `families/${familyId}`));
  assert.equal(fam.get('members')[a.auth.currentUser.uid].name, 'Pat Morrison');
  await assert.rejects(a.call('updateMyName', { name: '   ' }), /Enter your name/);
  await a.close();
});

const JAKE = { firstName: 'Jake', lastName: 'Morrison', sport: 'mlax', gradYear: 2029, position: 'midfield', openDivisions: ['D1', 'D3'] };

test('addPlayer needs Pro, then respects maxPlayers', async () => {
  const a = await newClient('pro-parent');
  const { familyId } = await a.call('bootstrapFamily', {});
  await a.claims();
  await assert.rejects(a.call('addPlayer', JAKE), /needs LaxHQ Pro/);

  await a.call('devSetPlan', { plan: 'pro', maxPlayers: 1 });
  assert.equal((await a.claims()).pro, true);
  const { playerId } = await a.call('addPlayer', JAKE);
  const p = await getDoc(doc(a.db, `families/${familyId}/players/${playerId}`));
  assert.equal(p.get('gradYear'), 2029);
  assert.equal(p.get('targetCount'), 0);
  assert.match(p.get('cardSlug'), /^[a-z2-9]{8}$/);
  const st = await getDoc(doc(a.db, `families/${familyId}/players/${playerId}/checklist/state`));
  assert.deepEqual(st.get('done'), {});

  await assert.rejects(a.call('addPlayer', { ...JAKE, firstName: 'Sam' }), /Add a sibling/);
  await a.call('devSetPlan', { plan: 'pro', maxPlayers: 2 });
  await a.call('addPlayer', { ...JAKE, firstName: 'Sam', gradYear: 2031 });
  const fam = await getDoc(doc(a.db, `families/${familyId}`));
  assert.equal(fam.get('playerCount'), 2);
});

test('addPlayer and updatePlayer validate input', async () => {
  const a = await newClient('validator');
  const { familyId } = await a.call('bootstrapFamily', {});
  await a.call('devSetPlan', { plan: 'pro' });
  await a.claims();
  await assert.rejects(a.call('addPlayer', { ...JAKE, gradYear: 1999 }), /Grad year must be between/);
  const { playerId } = await a.call('addPlayer', JAKE);
  await a.call('updatePlayer', { playerId, jersey: '22', academics: { gpa: 3.7 }, cardPublished: true });
  const p = await getDoc(doc(a.db, `families/${familyId}/players/${playerId}`));
  assert.equal(p.get('jersey'), '22');
  assert.equal(p.get('academics').gpa, 3.7);
  assert.equal(p.get('cardPublished'), true);
  await assert.rejects(a.call('updatePlayer', { playerId, position: 'striker' }), /Position is not valid/);
  await assert.rejects(a.call('updatePlayer', { playerId: 'nope', jersey: '1' }), /not found/);

  // Back to free: edits are refused.
  await a.call('devSetPlan', { plan: 'free' });
  await a.claims();
  await assert.rejects(a.call('updatePlayer', { playerId, jersey: '9' }), /needs LaxHQ Pro/);
});

test('publishing builds the public card; unpublishing removes it', async () => {
  const a = await newClient('carder');
  const { familyId } = await a.call('bootstrapFamily', {});
  await a.call('devSetPlan', { plan: 'pro' });
  await a.claims();
  const { playerId } = await a.call('addPlayer', { ...JAKE, jersey: '22', academics: { gpa: 3.7, sat: 1340 }, stats: { goals: 31 } });
  const slug = (await adb.doc(`families/${familyId}/players/${playerId}`).get()).get('cardSlug');
  await until(async () => (await adb.doc(`cardSlugs/${slug}`).get()).exists);
  assert.equal((await adb.doc(`cards/${slug}`).get()).exists, false, 'not public until published');

  await a.call('updatePlayer', { playerId, cardPublished: true });
  const card = await until(async () => { const c = await adb.doc(`cards/${slug}`).get(); return c.exists && c.data(); });
  assert.equal(card.firstName, 'Jake');
  assert.equal(card.lastInitial, 'M');
  assert.equal(card.lastName, undefined);
  assert.equal(card.sat, undefined);
  assert.equal(card.gpa, 3.7);
  assert.match(card.contactEmail, /@example\.com$/);

  await a.call('updatePlayer', { playerId, jersey: '7' });
  await until(async () => (await adb.doc(`cards/${slug}`).get()).get('jersey') === '7');

  await a.call('updatePlayer', { playerId, cardPublished: false });
  await until(async () => !(await adb.doc(`cards/${slug}`).get()).exists);
});

test('card views: counted once per viewer, bots ignored, coach tokens attributed', async () => {
  const a = await newClient('viewed');
  const { familyId } = await a.call('bootstrapFamily', {});
  await a.call('devSetPlan', { plan: 'pro' });
  await a.claims();
  const { playerId } = await a.call('addPlayer', JAKE);
  const pref = adb.doc(`families/${familyId}/players/${playerId}`);
  const slug = (await pref.get()).get('cardSlug');
  await a.call('updatePlayer', { playerId, cardPublished: true });
  await until(async () => (await adb.doc(`cards/${slug}`).get()).exists);

  assert.equal((await view(slug)).counted, true);
  assert.equal((await view(slug)).counted, false, 'same viewer within 30 minutes');
  assert.equal((await view(slug, undefined, 'Microsoft Office SafeLinks')).reason, 'bot');
  assert.equal((await view('nosuchslug')).status, 404);

  await adb.doc('cardTokens/tokTufts1').set({ fid: familyId, pid: playerId, contactId: 'c1', schoolName: 'Tufts University' });
  await adb.doc('cardTokens/tokOther1').set({ fid: 'someone-else', pid: 'x', contactId: 'c9', schoolName: 'Spoof U' });
  assert.equal((await view(slug, 'tokTufts1', CHROME, '198.51.100.4')).counted, true);
  assert.equal((await view(slug, 'tokOther1', CHROME, '198.51.100.5')).counted, true);

  const st = (await pref.get()).get('cardStats');
  assert.equal(st.total, 3);
  assert.equal(st.views30d, 3);
  assert.deepEqual(st.recentSchools, ['Tufts University'], 'a token from another family is not attributed');
  const contact = await adb.doc(`families/${familyId}/players/${playerId}/contacts/c1`).get();
  assert.equal(contact.get('cardViews'), 1);
});

// ---------- Phase 4: coach outreach ----------
let mock;
before(async () => { mock = await startMockAnthropic(); });
after(async () => { await mock?.close(); });

async function proPlayer(label, extra = {}) {
  const a = await newClient(label);
  const { familyId } = await a.call('bootstrapFamily', {});
  await a.call('devSetPlan', { plan: 'pro' });
  await a.claims();
  const { playerId } = await a.call('addPlayer', { ...JAKE, ...extra });
  return { a, fid: familyId, pid: playerId, base: `families/${familyId}/players/${playerId}` };
}

test('aiDraftEmail sends the profile to Claude, adds a tracked card link and counts the quota', async () => {
  const { a, fid, pid, base } = await proPlayer('drafter', { academics: { gpa: 3.7 }, club: { name: 'Chesapeake Elite' } });
  await a.call('updatePlayer', { playerId: pid, cardPublished: true });
  await adb.doc(`${base}/targets/tufts-university`).set({ schoolId: 'tufts-university', name: 'Tufts University', notes: 'Strong engineering school.' });
  await adb.doc(`${base}/contacts/c1`).set({ schoolId: 'tufts-university', schoolName: 'Tufts University', name: 'Coach Reyes', role: 'head', email: 'reyes@tufts.edu', stage: 'to_email' });

  mock.setReply(() => ({ json: { subject: 'Class of 2029 Midfield · Chesapeake Elite · Jake Morrison', body: 'Coach Reyes,\n\nI am Jake.\n\nJake Morrison' } }));
  const before = mock.requests.length;
  const draft = await a.call('aiDraftEmail', { playerId: pid, contactId: 'c1', kind: 'intro', appOrigin: 'http://127.0.0.1:5000' });
  assert.match(draft.subject, /Class of 2029/);
  assert.equal(draft.remaining, 59);

  const sent = mock.requests[before].body;
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.deepEqual(sent.fallbacks, 'default');
  const facts = sent.messages[0].content;
  assert.match(facts, /Jake Morrison, Class of 2029, midfield/);
  assert.match(facts, /Strong engineering school/);
  const token = (await adb.doc(`${base}/contacts/c1`).get()).get('cardToken');
  assert.ok(token);
  assert.match(facts, new RegExp(`http://127.0.0.1:5000/c/[a-z2-9]{8}\\?r=${token}`));
  assert.equal((await adb.doc(`cardTokens/${token}`).get()).get('schoolName'), 'Tufts University');

  // A refusal returns a clear error and gives the draft back.
  mock.setReply(() => ({ stop_reason: 'refusal' }));
  await assert.rejects(a.call('aiDraftEmail', { playerId: pid, contactId: 'c1', appOrigin: 'http://127.0.0.1:5000' }), /couldn’t draft/);
  const month = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  assert.equal((await adb.doc(`usage/${fid}_${month}`).get()).get('aiDrafts'), 1);

  // Out of drafts for the month.
  await adb.doc(`usage/${fid}_${month}`).set({ aiDrafts: 60 }, { merge: true });
  await assert.rejects(a.call('aiDraftEmail', { playerId: pid, contactId: 'c1', appOrigin: 'http://127.0.0.1:5000' }), /used all 60 AI drafts/);
  mock.setReply(() => ({ json: { subject: 'S', body: 'B' } }));
});

test('contactCardLink needs a published card and returns a tracked link', async () => {
  const { a, pid, base } = await proPlayer('linker');
  await adb.doc(`${base}/contacts/c2`).set({ schoolId: 'lafayette-college', schoolName: 'Lafayette College', name: 'Coach Kim' });
  await assert.rejects(a.call('contactCardLink', { playerId: pid, contactId: 'c2', appOrigin: 'https://laxhq.app' }), /Turn on sharing/);
  await a.call('updatePlayer', { playerId: pid, cardPublished: true });
  const { url } = await a.call('contactCardLink', { playerId: pid, contactId: 'c2', appOrigin: 'https://laxhq.app/anything' });
  assert.match(url, /^https:\/\/laxhq\.app\/c\/[a-z2-9]{8}\?r=[A-Za-z2-9]{12}$/);
  const again = await a.call('contactCardLink', { playerId: pid, contactId: 'c2', appOrigin: 'https://laxhq.app' });
  assert.equal(again.url, url, 'the same coach keeps the same token');
});

test('coach directory: two families confirm an email; a bounce hides it', async () => {
  const f1 = await proPlayer('dir1');
  const f2 = await proPlayer('dir2');
  const coach = { schoolId: 'middlebury-college', schoolName: 'Middlebury College', name: 'Coach Ellis', role: 'assistant', email: 'Ellis@Middlebury.edu' };
  await adb.doc(`${f1.base}/contacts/m1`).set(coach);
  await new Promise((r) => setTimeout(r, 1500));
  const none = await adb.collection('coaches').where('schoolId', '==', 'middlebury-college').get();
  assert.equal(none.size, 0, 'one family alone is only a suggestion');

  await adb.doc(`${f2.base}/contacts/m2`).set({ ...coach, email: 'ellis@middlebury.edu ' });
  const promoted = await until(async () => { const q = await adb.collection('coaches').where('schoolId', '==', 'middlebury-college').get(); return q.docs[0]; });
  assert.equal(promoted.get('status'), 'active');
  assert.equal(promoted.get('confirmations'), 2);
  assert.equal(promoted.get('email'), 'ellis@middlebury.edu');
  await until(async () => (await adb.doc(`${f2.base}/contacts/m2`).get()).get('coachId') === promoted.id);

  // Families can read active coaches; the suggestion log stays private.
  await f1.a.claims();
  assert.equal((await getDoc(doc(f1.a.db, `coaches/${promoted.id}`))).get('name'), 'Coach Ellis');

  const r = await f1.a.call('reportCoach', { coachId: promoted.id, reason: 'bounced' });
  assert.equal(r.suppressed, true);
  assert.equal((await adb.doc(`coaches/${promoted.id}`).get()).get('status'), 'suppressed');
});

test('a logged reply alone promotes a coach', async () => {
  const f = await proPlayer('replier');
  await adb.doc(`${f.base}/contacts/r1`).set({ schoolId: 'bowdoin-college', schoolName: 'Bowdoin College', name: 'Coach Park', email: 'park@bowdoin.edu', lastReplyAt: new Date() });
  const c = await until(async () => { const q = await adb.collection('coaches').where('schoolId', '==', 'bowdoin-college').get(); return q.docs[0]; });
  assert.equal(c.get('replyConfirmed'), true);
});

test('reportOutcome publishes a school GPA average only from 5 shared reports', async () => {
  const families = [];
  for (let i = 0; i < 5; i++) families.push(await proPlayer(`commit${i}`, { academics: { gpa: 3.4 + i * 0.1 } }));
  for (const [i, f] of families.entries()) {
    await adb.doc(`${f.base}/targets/hamilton-college`).set({ schoolId: 'hamilton-college', name: 'Hamilton College' });
    await f.a.call('reportOutcome', { playerId: f.pid, targetId: 'hamilton-college', share: true });
    const stats = (await adb.doc('schoolStats/hamilton-college_mlax').get()).get('committed');
    if (i < 4) assert.equal(stats, null, `hidden with ${i + 1} reports`);
    else assert.deepEqual(stats, { count: 5, avgGpa: 3.6 });
  }
});

test('daily nudges turn due follow-ups into one alert each', async () => {
  const f = await proPlayer('nudged');
  await adb.doc(`${f.base}/contacts/n1`).set({ schoolName: 'Colgate University', name: 'Coach Diaz', stage: 'emailed', nextFollowUpAt: new Date(Date.now() - 3600e3) });
  await adb.doc(`${f.base}/contacts/n2`).set({ schoolName: 'Bucknell University', name: 'Coach Fox', stage: 'emailed', nextFollowUpAt: new Date(Date.now() + 10 * 864e5) });
  const first = await f.a.call('devRunNudges', {});
  assert.ok(first.written >= 1);
  const alerts = await adb.collection(`${f.base}/alerts`).get();
  assert.equal(alerts.size, 1);
  assert.match(alerts.docs[0].get('title'), /Follow up with Coach Diaz at Colgate University/);
  await f.a.call('devRunNudges', {});
  assert.equal((await adb.collection(`${f.base}/alerts`).get()).size, 1, 'no duplicate alert');
  await f.a.call('devRunNudges', { asOf: new Date(Date.now() + 11 * 864e5).toISOString() });
  assert.equal((await adb.collection(`${f.base}/alerts`).get()).size, 2);
});
