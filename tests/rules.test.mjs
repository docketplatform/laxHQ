// Security rules tests. Run with: npm run test:rules (starts the Firestore and Storage emulators).
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, increment,
} from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';

let env;
const FID = 'fam_a';
const OTHER = 'fam_b';
const PID = 'p1';

const free = () => env.authenticatedContext('alice', { fid: FID, pro: false }).firestore();
const pro = () => env.authenticatedContext('alice', { fid: FID, pro: true }).firestore();
const outsider = () => env.authenticatedContext('mallory', { fid: OTHER, pro: true }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-laxhq',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/alice'), { familyId: FID, role: 'parent', displayName: 'Alice' });
    await setDoc(doc(db, `families/${FID}`), {
      name: 'Morrison family', memberUids: ['alice'], ownerUid: 'alice', playerCount: 1,
      entitlement: { plan: 'free', status: null },
    });
    await setDoc(doc(db, `families/${FID}/players/${PID}`), { firstName: 'Jake', gradYear: 2029, targetCount: 0 });
    await setDoc(doc(db, `families/${FID}/players/${PID}/alerts/a1`), { type: 'overlap', title: 'x', dismissedAt: null });
    await setDoc(doc(db, 'config/plans'), { free: { viewOnly: true } });
    await setDoc(doc(db, 'feeds/f1'), { url: 'https://secret.example/cal.ics' });
    await setDoc(doc(db, 'invites/ABCDEFGHJK'), { fid: FID, role: 'player' });
    await setDoc(doc(db, 'teams/t1'), { name: 'Team', memberFids: [FID] });
  });
});

// ---- users ----
test('users: read own doc, not someone else’s', async () => {
  await assertSucceeds(getDoc(doc(free(), 'users/alice')));
  await assertFails(getDoc(doc(outsider(), 'users/alice')));
});
test('users: can change display name but not familyId or role', async () => {
  await assertSucceeds(updateDoc(doc(free(), 'users/alice'), { displayName: 'Al' }));
  await assertFails(updateDoc(doc(free(), 'users/alice'), { familyId: OTHER }));
  await assertFails(updateDoc(doc(free(), 'users/alice'), { role: 'player' }));
});
test('users: clients cannot create user docs', async () => {
  await assertFails(setDoc(doc(env.authenticatedContext('newbie', {}).firestore(), 'users/newbie'), { familyId: FID }));
});

// ---- families ----
test('families: members read, outsiders and signed-out users do not', async () => {
  await assertSucceeds(getDoc(doc(free(), `families/${FID}`)));
  await assertFails(getDoc(doc(outsider(), `families/${FID}`)));
  await assertFails(getDoc(doc(anon(), `families/${FID}`)));
});
test('families: rename allowed, entitlement and members are not', async () => {
  await assertSucceeds(updateDoc(doc(free(), `families/${FID}`), { name: 'The Morrisons' }));
  await assertFails(updateDoc(doc(pro(), `families/${FID}`), { 'entitlement.plan': 'pro' }));
  await assertFails(updateDoc(doc(pro(), `families/${FID}`), { memberUids: ['alice', 'mallory'] }));
});
test('families: clients cannot create families', async () => {
  await assertFails(setDoc(doc(pro(), 'families/fam_new'), { name: 'x', memberUids: ['alice'] }));
});

// ---- free accounts are view-only ----
test('free: can read player data but cannot write any of it', async () => {
  await assertSucceeds(getDoc(doc(free(), `families/${FID}/players/${PID}`)));
  await assertFails(updateDoc(doc(free(), `families/${FID}/players/${PID}`), { gradYear: 2030 }));
  await assertFails(setDoc(doc(free(), `families/${FID}/players/${PID}/contacts/c1`), { name: 'Coach' }));
  await assertFails(setDoc(doc(free(), `families/${FID}/players/${PID}/checklist/state`), { done: {} }));
  await assertFails(setDoc(doc(free(), `families/${FID}/expenses/e1`), { amountCents: 100, source: 'manual' }));
});

// ---- pro writes ----
test('pro: player profile edits go through functions, not direct writes', async () => {
  await assertFails(updateDoc(doc(pro(), `families/${FID}/players/${PID}`), { gradYear: 2030 }));
  await assertFails(setDoc(doc(pro(), `families/${FID}/players/p2`), { firstName: 'Sib' }));
});
test('pro: can write contacts, checklist and plan', async () => {
  const db = pro();
  await assertSucceeds(setDoc(doc(db, `families/${FID}/players/${PID}/contacts/c1`), { name: 'Coach' }));
  await assertSucceeds(setDoc(doc(db, `families/${FID}/players/${PID}/checklist/state`), { done: {} }));
  await assertSucceeds(setDoc(doc(db, `families/${FID}/players/${PID}/plan/e1`), { title: 'Showcase' }));
});
test('pro: cannot touch server-owned player fields', async () => {
  await assertFails(updateDoc(doc(pro(), `families/${FID}/players/${PID}`), { cardStats: { views30d: 999 } }));
  await assertFails(updateDoc(doc(pro(), `families/${FID}/players/${PID}`), { teamIds: ['t9'] }));
});
test('pro: unknown subcollections are denied', async () => {
  await assertFails(setDoc(doc(pro(), `families/${FID}/players/${PID}/secrets/x`), { a: 1 }));
});
test('outsider with Pro still cannot write another family', async () => {
  await assertFails(setDoc(doc(outsider(), `families/${FID}/players/${PID}/contacts/c1`), { name: 'x' }));
});

// ---- targets + counter ----
test('targets: create succeeds only with the counter bumped in the same batch', async () => {
  const db = pro();
  const b1 = writeBatch(db);
  b1.set(doc(db, `families/${FID}/players/${PID}/targets/s1`), { name: 'Tufts' });
  b1.update(doc(db, `families/${FID}/players/${PID}`), { targetCount: increment(1) });
  await assertSucceeds(b1.commit());

  await assertFails(setDoc(doc(db, `families/${FID}/players/${PID}/targets/s2`), { name: 'No counter' }));

  const b2 = writeBatch(db);
  b2.delete(doc(db, `families/${FID}/players/${PID}/targets/s1`));
  b2.update(doc(db, `families/${FID}/players/${PID}`), { targetCount: increment(-1) });
  await assertSucceeds(b2.commit());
});
test('targets: the 500-school cap holds', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), `families/${FID}/players/${PID}`), { targetCount: 500 });
  });
  const db = pro();
  const b = writeBatch(db);
  b.set(doc(db, `families/${FID}/players/${PID}/targets/s501`), { name: 'One too many' });
  b.update(doc(db, `families/${FID}/players/${PID}`), { targetCount: increment(1) });
  await assertFails(b.commit());
});
test('targets: free accounts cannot add a school even with the counter', async () => {
  const db = free();
  const b = writeBatch(db);
  b.set(doc(db, `families/${FID}/players/${PID}/targets/s1`), { name: 'Tufts' });
  b.update(doc(db, `families/${FID}/players/${PID}`), { targetCount: increment(1) });
  await assertFails(b.commit());
});

// ---- alerts ----
test('alerts: members can only dismiss', async () => {
  await assertSucceeds(updateDoc(doc(free(), `families/${FID}/players/${PID}/alerts/a1`), { dismissedAt: new Date() }));
  await assertFails(updateDoc(doc(pro(), `families/${FID}/players/${PID}/alerts/a1`), { title: 'changed' }));
  await assertFails(setDoc(doc(pro(), `families/${FID}/players/${PID}/alerts/a2`), { type: 'overlap' }));
});

// ---- expenses ----
test('expenses: pro can add, edit and delete manual entries', async () => {
  const db = pro();
  const ref1 = doc(db, `families/${FID}/expenses/e1`);
  await assertSucceeds(setDoc(ref1, { amountCents: 41200, source: 'manual', category: 'hotels', date: '2026-11-08' }));
  await assertSucceeds(updateDoc(ref1, { amountCents: 40000 }));
  await assertSucceeds(deleteDoc(ref1));
});
test('expenses: clients cannot write LaxHQ or partner rows, or bad amounts', async () => {
  const db = pro();
  await assertFails(setDoc(doc(db, `families/${FID}/expenses/e2`), { amountCents: 50000, source: 'laxhq' }));
  await assertFails(setDoc(doc(db, `families/${FID}/expenses/e3`), { amountCents: 0, source: 'manual' }));
  await assertFails(setDoc(doc(db, `families/${FID}/expenses/e4`), { amountCents: 12.5, source: 'manual' }));
  await assertFails(setDoc(doc(db, `families/${FID}/expenses/e5`), { amountCents: 10000000, source: 'manual' }));
});
test('expenses: LaxHQ-added rows cannot be deleted by the family', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `families/${FID}/expenses/sub1`), { amountCents: 50000, source: 'laxhq' });
  });
  await assertFails(deleteDoc(doc(pro(), `families/${FID}/expenses/sub1`)));
  await assertSucceeds(getDoc(doc(free(), `families/${FID}/expenses/sub1`)));
});

// ---- public and server-only collections ----
test('config is public read, never client-writable', async () => {
  await assertSucceeds(getDoc(doc(anon(), 'config/plans')));
  await assertFails(setDoc(doc(pro(), 'config/plans'), { free: {} }));
});
test('feeds and invites are server-only', async () => {
  await assertFails(getDoc(doc(pro(), 'feeds/f1')));
  await assertFails(getDoc(doc(pro(), 'invites/ABCDEFGHJK')));
  await assertFails(setDoc(doc(pro(), 'invites/ZZZZZZZZZZ'), { fid: FID }));
});
test('teams: only member families can read', async () => {
  await assertSucceeds(getDoc(doc(free(), 'teams/t1')));
  await assertFails(getDoc(doc(outsider(), 'teams/t1')));
});

// ---- storage: receipts ----
test('receipts: own family on Pro can upload an image; others cannot', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const meta = { contentType: 'image/jpeg' };
  const proStorage = env.authenticatedContext('alice', { fid: FID, pro: true }).storage();
  const freeStorage = env.authenticatedContext('alice', { fid: FID, pro: false }).storage();
  const otherStorage = env.authenticatedContext('mallory', { fid: OTHER, pro: true }).storage();
  await assertSucceeds(uploadBytes(ref(proStorage, `receipts/${FID}/r1.jpg`), bytes, meta));
  await assertFails(uploadBytes(ref(freeStorage, `receipts/${FID}/r2.jpg`), bytes, meta));
  await assertFails(uploadBytes(ref(otherStorage, `receipts/${FID}/r3.jpg`), bytes, meta));
  await assertFails(uploadBytes(ref(proStorage, `receipts/${FID}/r4.exe`), bytes, { contentType: 'application/x-msdownload' }));
});

test('cards are public; slug maps, tokens and view logs are server-only', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'cards/abcd2345'), { firstName: 'Jake' });
    await setDoc(doc(db, 'cardSlugs/abcd2345'), { fid: FID, pid: PID });
    await setDoc(doc(db, 'cardTokens/t1'), { fid: FID });
  });
  await assertSucceeds(getDoc(doc(anon(), 'cards/abcd2345')));
  await assertFails(setDoc(doc(pro(), 'cards/abcd2345'), { firstName: 'Fake' }));
  await assertFails(getDoc(doc(pro(), 'cardSlugs/abcd2345')));
  await assertFails(getDoc(doc(pro(), 'cardTokens/t1')));
  await assertFails(getDoc(doc(pro(), 'cardViews/abcd2345/views/v1')));
});

test('coach directory: active coaches readable by signed-in users; suggestions, reports, outcomes private', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'coaches/k1'), { status: 'active', name: 'Coach A' });
    await setDoc(doc(db, 'coaches/k2'), { status: 'suppressed', name: 'Coach B' });
    await setDoc(doc(db, 'coachSuggestions/k1'), { fids: [FID] });
    await setDoc(doc(db, 'outcomes/x'), { gpa: 3.5 });
    await setDoc(doc(db, 'schoolStats/s_mlax'), { committed: null });
  });
  await assertSucceeds(getDoc(doc(free(), 'coaches/k1')));
  await assertFails(getDoc(doc(free(), 'coaches/k2')));
  await assertFails(setDoc(doc(pro(), 'coaches/k3'), { status: 'active' }));
  await assertFails(getDoc(doc(pro(), 'coachSuggestions/k1')));
  await assertFails(getDoc(doc(pro(), 'outcomes/x')));
  await assertSucceeds(getDoc(doc(anon(), 'schoolStats/s_mlax')));
});
test('touches live under the player; pro writes them', async () => {
  await assertSucceeds(setDoc(doc(pro(), `families/${FID}/players/${PID}/touches/t1`), { contactId: 'c1', type: 'email_out', at: new Date() }));
  await assertFails(setDoc(doc(free(), `families/${FID}/players/${PID}/touches/t2`), { contactId: 'c1', type: 'email_out' }));
});

test('billing records and webhook logs are server-only', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `families/${FID}/billing/stripe`), { active: true });
    await setDoc(doc(db, 'billingEvents/evt_1'), { type: 'x' });
  });
  await assertFails(getDoc(doc(pro(), `families/${FID}/billing/stripe`)));
  await assertFails(setDoc(doc(pro(), `families/${FID}/billing/stripe`), { active: true }));
  await assertFails(getDoc(doc(pro(), 'billingEvents/evt_1')));
});
