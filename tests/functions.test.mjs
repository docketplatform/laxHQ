// End-to-end tests for the Phase 0 callables, run against the Auth, Firestore and
// Functions emulators: npm run test:functions
import { test, before, after, afterEach } from 'node:test';
import { startMockAnthropic } from './mock-anthropic.mjs';
import { startFeedServer, ics } from './feed-server.mjs';
import { getStorage as adminStorage } from 'firebase-admin/storage';
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

if (!adminApps().length) adminInit({ projectId: PROJECT_ID_FOR_ADMIN(), storageBucket: 'demo-laxhq.appspot.com' });
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

// ---------- Phase 5: schedule import, overlaps, expenses ----------
const Y = new Date().getFullYear() + 1;
const GAMES = [
  { uid: 'g1@ts', date: `${Y}-07-24`, time: '0900', title: 'Game vs Express', cal: 'Chesapeake Elite 2029', location: 'Philadelphia PA' },
  { uid: 'g2@ts', date: `${Y}-07-25`, time: '1300', title: 'Game vs Laxachusetts', cal: 'Chesapeake Elite 2029' },
  { uid: 'g3@ts', date: `${Y}-06-10`, title: 'Practice', cal: 'Chesapeake Elite 2029' },
  { uid: 'g4@ts', date: `${Y}-06-17`, title: 'Practice', cal: 'Chesapeake Elite 2029' },
  { uid: 'g5@ts', date: `${Y}-06-24`, title: 'Practice', cal: 'Chesapeake Elite 2029' },
];
const SOCCER = [{ uid: 's1@ts', date: `${Y}-07-24`, title: 'U10 Soccer', cal: 'Sam - U10 Soccer' }];
let feeds;
before(async () => {
  feeds = await startFeedServer({
    '/parentA.ics': ics([...GAMES, ...SOCCER]),
    '/parentB.ics': ics(GAMES),
    '/sameAsA.ics': ics(GAMES),
  });
});
after(async () => { await feeds?.close(); });

async function connect(f, path, calendars) {
  const c = await f.a.call('connectSchedule', { playerId: f.pid, url: feeds.url(path) });
  return f.a.call('selectCalendars', { feedId: c.feedId, calendars: calendars || c.calendars.map((x) => x.name) });
}

test('connecting a feed lists its calendars; picking one creates the team with only those events', async () => {
  const f = await proPlayer('sched1');
  const c = await f.a.call('connectSchedule', { playerId: f.pid, url: feeds.url('/parentA.ics') });
  assert.deepEqual(c.calendars.map((x) => x.name).sort(), ['Chesapeake Elite 2029', 'Sam - U10 Soccer']);
  await assert.rejects(f.a.call('selectCalendars', { feedId: c.feedId, calendars: [] }), /Pick at least one/);
  const r = await f.a.call('selectCalendars', { feedId: c.feedId, calendars: ['Chesapeake Elite 2029'] });
  assert.equal(r.joined, false);
  assert.equal(r.eventCount, 5);
  const evs = await adb.collection(`teams/${r.teamId}/events`).get();
  assert.equal(evs.size, 5);
  assert.ok(evs.docs.every((d) => d.get('calendar') === 'Chesapeake Elite 2029'));
  assert.deepEqual((await adb.doc(f.base).get()).get('teamIds'), [r.teamId]);
  // Family members can read their team; the feed link stays server-only.
  await f.a.claims();
  assert.equal((await getDoc(doc(f.a.db, `teams/${r.teamId}`))).get('eventCount'), 5);
  await assert.rejects(getDoc(doc(f.a.db, `feeds/${c.feedId}`)));
  await assert.rejects(f.a.call('connectSchedule', { playerId: f.pid, url: feeds.url('/missing.ics') }), /no longer works/);
});

test('one sync covers the whole team: same link, or a different personal link with the same events', async () => {
  const f1 = await proPlayer('team1');
  const first = await connect(f1, '/parentB.ics');
  const f2 = await proPlayer('team2');
  const second = await connect(f2, '/parentB.ics');
  assert.equal(second.teamId, first.teamId);
  assert.equal(second.joined, true);
  const f3 = await proPlayer('team3');
  const third = await connect(f3, '/sameAsA.ics');
  assert.equal(third.teamId, first.teamId, 'personal link matched by event UIDs');
  const team = await adb.doc(`teams/${first.teamId}`).get();
  // (The family from the previous test has the same games, so it is on this team too.)
  for (const f of [f1, f2, f3]) assert.ok(team.get('memberFids').includes(f.fid));
  assert.ok(team.get('feedIds').length >= 3, 'one feed record per family');
});

test('summer events: overlap alerts, planned expenses and the card summer line', async () => {
  const f = await proPlayer('planner');
  await connect(f, '/parentB.ics');
  await adb.doc(`${f.base}/plan/pe1`).set({ kind: 'showcase', title: 'Northeast Elite Weekend', start: `${Y}-07-24`, end: `${Y}-07-26`, status: 'registered', costEstimate: 1400, location: { city: 'Newport', state: 'RI' } });
  const alert = await until(async () => { const a = await adb.doc(`${f.base}/alerts/overlap_pe1`).get(); return a.exists && a.data(); });
  assert.match(alert.title, /Northeast Elite Weekend overlaps Chesapeake Elite 2029: Game vs Express on Jul 24 and 1 more/);
  const exp = await until(async () => { const e = await adb.doc(`families/${f.fid}/expenses/plan_${f.pid}_pe1`).get(); return e.exists && e.data(); });
  assert.equal(exp.amountCents, 140000);
  assert.equal(exp.status, 'planned');
  await until(async () => JSON.stringify((await adb.doc(f.base).get()).get('cardSummer')) === '["Newport"]');

  // Move the event: the clash goes away. Attend it: the expense becomes spent.
  await adb.doc(`${f.base}/plan/pe1`).update({ start: `${Y}-08-07`, end: `${Y}-08-08`, status: 'attended', actualCost: 1250 });
  await until(async () => !(await adb.doc(`${f.base}/alerts/overlap_pe1`).get()).exists);
  await until(async () => (await adb.doc(`families/${f.fid}/expenses/plan_${f.pid}_pe1`).get()).get('amountCents') === 125000);
  await adb.doc(`${f.base}/plan/pe1`).delete();
  await until(async () => !(await adb.doc(`families/${f.fid}/expenses/plan_${f.pid}_pe1`).get()).exists);
});

test('sync updates events, cancels removed ones, fails over, then alerts when every link is dead', async () => {
  feeds.routes['/syncA.ics'] = ics(GAMES.map((g) => ({ ...g, uid: `s-${g.uid}` })));
  feeds.routes['/syncB.ics'] = ics(GAMES.map((g) => ({ ...g, uid: `s-${g.uid}` })));
  const f1 = await proPlayer('sync1');
  const r = await connect(f1, '/syncA.ics');
  const f2 = await proPlayer('sync2');
  await connect(f2, '/syncB.ics');

  // A game is dropped and another moves.
  feeds.routes['/syncA.ics'] = ics(GAMES.filter((g) => g.uid !== 'g2@ts').map((g) => ({ ...g, uid: `s-${g.uid}`, title: g.uid === 'g1@ts' ? 'Game vs Express (moved)' : g.title })));
  await f1.a.call('devSyncTeams', {});
  const evs = await adb.collection(`teams/${r.teamId}/events`).get();
  assert.ok(evs.docs.some((d) => d.get('title') === 'Game vs Express (moved)'));
  assert.equal(evs.docs.find((d) => d.get('uid') === 's-g2@ts').get('cancelled'), true);

  // The primary link dies: after repeated failures the team switches to the other family's link.
  feeds.routes['/syncA.ics'] = { status: 404 };
  const team = await adb.doc(`teams/${r.teamId}`).get();
  await adb.doc(`feeds/${team.get('primaryFeedId')}`).update({ consecutiveFailures: 4 });
  await f1.a.call('devSyncTeams', {});
  const after1 = await adb.doc(`teams/${r.teamId}`).get();
  assert.notEqual(after1.get('primaryFeedId'), team.get('primaryFeedId'));
  assert.equal(after1.get('syncStatus'), 'ok');

  // Both links dead: the team is marked as failing and each player gets an alert.
  feeds.routes['/syncB.ics'] = { status: 410 };
  await adb.doc(`feeds/${after1.get('primaryFeedId')}`).update({ consecutiveFailures: 4 });
  await f1.a.call('devSyncTeams', {});
  assert.equal((await adb.doc(`teams/${r.teamId}`).get()).get('syncStatus'), 'error');
  const alert = await adb.doc(`${f1.base}/alerts/sync_${r.teamId}`).get();
  assert.match(alert.get('title'), /stopped syncing/);
});

test('scanReceipt reads an uploaded receipt and only the owner family can use it', async () => {
  const f = await proPlayer('receipts');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const path = `receipts/${f.fid}/r1.png`;
  await adminStorage().bucket().file(path).save(png, { contentType: 'image/png' });
  mock.setReply((body) => {
    assert.equal(body.messages[0].content[0].type, 'image');
    return { json: { amount: '$412.36', date: '2026-11-08', payee: 'Hampton Inn', category: 'hotels' } };
  });
  const out = await f.a.call('scanReceipt', { path });
  assert.deepEqual(out, { amount: '412.36', date: '2026-11-08', payee: 'Hampton Inn', category: 'hotels' });
  const other = await proPlayer('snooper');
  await assert.rejects(other.a.call('scanReceipt', { path }), /not found/);
  mock.setReply(() => ({ json: { subject: 'S', body: 'B' } }));
});

// ---------- Phase 6: billing ----------
import { createRequire as _cr } from 'node:module';
import { startMockStripe, subscription } from './mock-stripe.mjs';

const StripeLib = _cr(import.meta.url)('../functions/node_modules/stripe');
const signer = new (StripeLib.default || StripeLib)('sk_test_emulator');
const HOOK = 'http://127.0.0.1:5001/demo-laxhq/us-central1/stripeWebhook';
let stripeMock;
before(async () => { stripeMock = await startMockStripe(); });
after(async () => { await stripeMock?.close(); });

let evN = 0;
async function stripeEvent(type, object, { secret = 'whsec_emulator' } = {}) {
  const payload = JSON.stringify({ id: `evt_test_${Date.now()}_${evN++}`, object: 'event', type, data: { object } });
  const header = signer.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header }, body: payload });
  return { status: res.status, body: await res.text(), payload };
}

test('createCheckout: annual plan with siblings, monthly without; links the Stripe customer', async () => {
  const a = await newClient('buyer');
  const { familyId } = await a.call('bootstrapFamily', {});
  const { url } = await a.call('createCheckout', { interval: 'year', siblings: 2, appOrigin: 'http://127.0.0.1:5000' });
  assert.match(url, /^https:\/\/checkout\.stripe\.test\//);
  const session = stripeMock.requests.filter((r) => r.url === '/v1/checkout/sessions').at(-1).body;
  assert.equal(session.mode, 'subscription');
  assert.equal(session.client_reference_id, familyId);
  assert.deepEqual(session.line_items, [{ price: 'price_pro_year', quantity: '1' }, { price: 'price_sibling_year', quantity: '2' }]);
  assert.equal(session.subscription_data.metadata.fid, familyId);
  assert.match(session.success_url, /^http:\/\/127\.0\.0\.1:5000\/\?checkout=success/);
  const cust = (await adb.doc(`families/${familyId}`).get()).get('stripeCustomerId');
  assert.match(cust, /^cus_test_/);

  await a.call('createCheckout', { interval: 'month', appOrigin: 'http://127.0.0.1:5000' });
  assert.equal(stripeMock.requests.filter((r) => r.url === '/v1/customers').length >= 1, true);
  const monthly = stripeMock.requests.filter((r) => r.url === '/v1/checkout/sessions').at(-1).body;
  assert.equal(monthly.customer, cust, 'the same customer is reused');
  assert.deepEqual(monthly.line_items, [{ price: 'price_pro_month', quantity: '1' }]);
  await assert.rejects(a.call('createCheckout', { interval: 'month', siblings: 1, appOrigin: 'http://127.0.0.1:5000' }), /annual plan/);
  // A family with a customer but no subscription can still open the portal; one with no customer can't.
  const fresh = await newClient('nocustomer');
  await fresh.call('bootstrapFamily', {});
  await assert.rejects(fresh.call('createPortal', { appOrigin: 'http://x.test' }), /no web subscription/);
});

test('Stripe webhook: checkout → Pro with siblings; renewals log the expense; cancel → Free', async () => {
  const a = await newClient('subscriber');
  const { familyId } = await a.call('bootstrapFamily', {});
  await a.call('createCheckout', { interval: 'year', siblings: 1, appOrigin: 'http://127.0.0.1:5000' });
  const cust = (await adb.doc(`families/${familyId}`).get()).get('stripeCustomerId');
  const subId = `sub_${familyId}`;
  stripeMock.subscriptions[subId] = subscription({ id: subId, customer: cust, fid: familyId, siblings: 1 });

  // A bad signature is rejected.
  assert.equal((await stripeEvent('customer.subscription.updated', stripeMock.subscriptions[subId], { secret: 'whsec_wrong' })).status, 400);

  const done = await stripeEvent('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', subscription: subId, customer: cust, client_reference_id: familyId });
  assert.equal(done.status, 200, done.body);
  const ent = (await adb.doc(`families/${familyId}`).get()).get('entitlement');
  assert.deepEqual([ent.plan, ent.source, ent.status, ent.interval, ent.maxPlayers], ['pro', 'stripe', 'active', 'year', 2]);
  assert.equal((await a.claims()).pro, true, 'claims updated');

  // The same event delivered twice is handled once.
  const again = await fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signer.webhooks.generateTestHeaderString({ payload: done.payload, secret: 'whsec_emulator' }) }, body: done.payload });
  assert.match(await again.text(), /duplicate/);

  // Each paid invoice shows up in the family's recruiting spend.
  await stripeEvent('invoice.paid', { id: 'in_1', object: 'invoice', customer: cust, amount_paid: 59900, number: 'LAX-0001', created: 1793000000, status_transitions: { paid_at: 1793000000 } });
  const exp = await adb.doc(`families/${familyId}/expenses/laxhq_in_1`).get();
  assert.equal(exp.get('amountCents'), 59900);
  assert.equal(exp.get('source'), 'laxhq');
  assert.equal(exp.get('category'), 'services');

  // Payment trouble keeps Pro while Stripe retries; cancellation ends it.
  await stripeEvent('customer.subscription.updated', subscription({ id: subId, customer: cust, status: 'past_due', siblings: 1 }));
  assert.equal((await adb.doc(`families/${familyId}`).get()).get('entitlement').status, 'past_due');
  await stripeEvent('customer.subscription.deleted', subscription({ id: subId, customer: cust, status: 'canceled' }));
  const after = (await adb.doc(`families/${familyId}`).get()).get('entitlement');
  assert.equal(after.plan, 'free');
  assert.equal((await a.claims()).pro, false);

  // The portal is available now that there's a customer.
  const portal = await a.call('createPortal', { appOrigin: 'http://127.0.0.1:5000' });
  assert.equal(portal.url, 'https://billing.stripe.test/portal');
});

test('RevenueCat webhook: checks the shared secret; purchase → Pro, expiration → Free', async () => {
  const a = await newClient('iosbuyer');
  const { familyId } = await a.call('bootstrapFamily', {});
  const RC = 'http://127.0.0.1:5001/demo-laxhq/us-central1/revenuecatWebhook';
  const send = (event, auth = 'Bearer rc_emulator') => fetch(RC, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ event }) });
  assert.equal((await send({ id: 'x', type: 'INITIAL_PURCHASE', app_user_id: familyId }, 'Bearer nope')).status, 401);
  const r = await send({ id: `rc1_${familyId}`, type: 'INITIAL_PURCHASE', app_user_id: familyId, product_id: 'laxhq_pro_year', store: 'APP_STORE', expiration_at_ms: Date.now() + 365 * 864e5 });
  assert.equal(r.status, 200);
  const ent = (await adb.doc(`families/${familyId}`).get()).get('entitlement');
  assert.deepEqual([ent.plan, ent.source], ['pro', 'revenuecat']);
  await send({ id: `rc2_${familyId}`, type: 'EXPIRATION', app_user_id: familyId, expiration_at_ms: Date.now() - 1000 });
  assert.equal((await adb.doc(`families/${familyId}`).get()).get('entitlement').plan, 'free');
});
