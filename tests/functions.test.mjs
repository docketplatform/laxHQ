// End-to-end tests for the Phase 0 callables, run against the Auth, Firestore and
// Functions emulators: npm run test:functions
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signOut,
} from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, terminate,
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

const PROJECT = 'demo-laxhq';
let n = 0;

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
  const close = async () => { await terminate(db); await signOut(auth); await deleteApp(app); };
  return { app, auth, db, call, claims, close };
}

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
