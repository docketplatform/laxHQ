// LaxHQ app core: sign-in, session, live data subscriptions and the router.
import {
  onAuthStateChanged, signInWithPopup, GoogleAuthProvider, OAuthProvider, sendSignInLinkToEmail,
  isSignInWithEmailLink, signInWithEmailLink, signOut, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  doc, getDoc, onSnapshot, collection, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { auth, db, call, params, USE_EMULATORS } from './firebase.js';
import { $, safeStorage, errorText } from './util.js';
import { views } from './views/index.js';
import { maybeSubmitDraft } from './views/onboarding.js';

// ---------- state ----------
export const state = {
  user: null,
  claims: {},
  family: null,
  plans: null,
  template: null,         // config/checklist
  rules: null,            // config/ncaaRules
  players: [],            // live list of this family's players
  playerId: null,         // the player being viewed
  checklist: null,        // live checklist/state for that player
  targets: [],            // live target schools for that player
  catalog: null,          // compact school index (catalog/index), loaded on demand
  ui: {},                 // messages that must survive live re-renders; cleared on navigation
  lastEntitlement: null,
  ready: false,          // true once both the family and the player list have loaded
  loaded: { family: false, players: false },
};

const subs = new Map();
function subscribe(key, unsub) { subs.get(key)?.(); subs.set(key, unsub); }
function unsubscribeAll() { for (const u of subs.values()) u(); subs.clear(); }

/** True while the family's Pro entitlement is active (from the ID token claim). */
export const isPro = () => state.claims.pro === true;

/** Feature gate shared by every screen. Free accounts are view-only. */
export function can(feature) {
  const plan = isPro() ? 'pro' : 'free';
  const limits = (state.plans && state.plans[plan]) || {};
  if (feature === 'save') return isPro() && !limits.viewOnly;
  if (feature === 'addPlayer') return isPro() && state.players.length < (state.family?.entitlement?.maxPlayers || 0);
  return Boolean(limits[feature]);
}

export function currentPlayer() {
  return state.players.find((p) => p.id === state.playerId) || state.players[0] || null;
}

export function setUi(key, value) { state.ui[key] = value; render(); }

export function selectPlayer(id) {
  if (!state.players.some((p) => p.id === id)) return;
  state.playerId = id;
  safeStorage.set('laxhq.player', id);
  watchPlayer();
  render();
}

const ctx = {
  state, call, db, can, isPro, setUi, currentPlayer, selectPlayer, USE_EMULATORS,
  navigate: (hash) => { if (location.hash === hash) render(); else location.hash = hash; },
  refreshClaims: async () => { await refreshClaims(); render(); },
  signOut: () => signOut(auth),
};

// ---------- router ----------
let lastRoute = '';
export function render() {
  if ($('app').hidden || !state.ready) return;
  const [name, ...args] = (location.hash.replace(/^#\//, '') || 'home').split('/');
  const view = views[name] ? name : 'home';
  const routeKey = `${view}/${args.join('/')}`;

  // Keep whatever the user is typing when live data re-renders the screen.
  const active = document.activeElement;
  const typing = active && active.id && $('view').contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)
    ? { id: active.id, value: active.value } : null;
  const formState = routeKey === lastRoute ? snapshotForms() : null;

  $('view').innerHTML = views[view].render(ctx, args);
  views[view].bind?.(ctx, args);

  if (formState) restoreForms(formState);
  if (typing && $(typing.id)) { $(typing.id).value = typing.value; $(typing.id).focus(); }
  if (routeKey !== lastRoute) { window.scrollTo(0, 0); }
  lastRoute = routeKey;

  const tab = views[view].tab || view;
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.getAttribute('href') === `#/${tab}`) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('plan-badge').textContent = isPro() ? 'Pro' : 'Free';
  $('plan-badge').classList.toggle('pro', isPro());
}

/** Unsaved edits in forms marked data-keep survive a live re-render. */
function snapshotForms() {
  const out = {};
  document.querySelectorAll('#view form[data-keep]').forEach((f) => {
    out[f.id] = [...f.elements].filter((e) => e.name && e.dataset.dirty).map((e) => [e.name, e.type === 'checkbox' ? e.checked : e.value, e.value]);
  });
  return out;
}
function restoreForms(saved) {
  for (const [id, fields] of Object.entries(saved)) {
    const f = $(id); if (!f) continue;
    for (const [name, v, raw] of fields) {
      const els = [...f.elements].filter((e) => e.name === name);
      for (const el of els) {
        if (el.type === 'checkbox') { if (el.value === raw || els.length === 1) el.checked = v; } else el.value = v;
        el.dataset.dirty = '1';
      }
    }
  }
}
document.addEventListener('input', (e) => { if (e.target.form?.dataset.keep !== undefined) e.target.dataset.dirty = '1'; });

window.addEventListener('hashchange', () => { state.ui = {}; render(); });

// ---------- sign-in ----------
if (params.get('invite')) safeStorage.set('laxhq.invite', params.get('invite'));

function showSignin() {
  $('loading').hidden = true; $('app').hidden = true; $('signin').hidden = false;
  $('invite-note').hidden = !safeStorage.get('laxhq.invite');
  $('dev-form').hidden = !USE_EMULATORS;
}
function signinMsg(text, bad) { const m = $('signin-msg'); m.className = bad ? 'err' : 'ok'; m.textContent = text; }

$('google').addEventListener('click', () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => signinMsg(errorText(e), true)));
$('apple').addEventListener('click', () => {
  const p = new OAuthProvider('apple.com'); p.addScope('email'); p.addScope('name');
  signInWithPopup(auth, p).catch((e) => signinMsg(errorText(e), true));
});
$('email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { signinMsg('Enter a valid email address.', true); return; }
  try {
    await sendSignInLinkToEmail(auth, email, { url: location.href.split('#')[0], handleCodeInApp: true });
    safeStorage.set('laxhq.emailForSignIn', email);
    signinMsg(`Check ${email} for your sign-in link.`);
  } catch (err) { signinMsg(errorText(err), true); }
});
$('dev-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('dev-email').value.trim(); const name = $('dev-name').value.trim();
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, 'emulator-only').catch((err) => {
      if (err.code === 'auth/email-already-in-use') return signInWithEmailAndPassword(auth, email, 'emulator-only');
      throw err;
    });
    if (name && !cred.user.displayName) { state.pendingName = name; await updateProfile(cred.user, { displayName: name }); }
  } catch (err) { signinMsg(errorText(err), true); }
});

if (isSignInWithEmailLink(auth, location.href)) {
  let email = safeStorage.get('laxhq.emailForSignIn');
  if (!email) email = window.prompt('Confirm your email to finish signing in');
  if (email) {
    signInWithEmailLink(auth, email, location.href)
      .then(() => { safeStorage.del('laxhq.emailForSignIn'); history.replaceState(null, '', location.pathname + (params.has('emulator') ? '?emulator=1' : '')); })
      .catch((e) => signinMsg(errorText(e), true));
  }
}

// ---------- session ----------
async function refreshClaims() {
  const res = await state.user.getIdTokenResult(true);
  state.claims = res.claims;
}

async function loadConfig() {
  const [plans, template, rules] = await Promise.all(['plans', 'checklist', 'ncaaRules']
    .map((id) => getDoc(doc(db, `config/${id}`)).then((s) => (s.exists() ? s.data() : null)).catch(() => null)));
  Object.assign(state, { plans, template, rules });
}

function watchPlayer() {
  const p = currentPlayer();
  if (!p) { subscribe('checklist', () => {}); subscribe('targets', () => {}); state.checklist = null; state.targets = []; return; }
  subscribe('checklist', onSnapshot(doc(db, `families/${state.claims.fid}/players/${p.id}/checklist/state`), (s) => {
    state.checklist = s.data() || { done: {}, skipped: {}, custom: {} };
    render();
  }, (err) => console.error('checklist', err)));
  subscribe('targets', onSnapshot(collection(db, `families/${state.claims.fid}/players/${p.id}/targets`), (s) => {
    state.targets = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => console.error('targets', err)));
}

function markReady() {
  if (!state.loaded.family || !state.loaded.players) return;
  state.ready = true;
  $('loading').hidden = true; $('app').hidden = false;
  render();
  maybeSubmitDraft(ctx);
}

async function startSession(user) {
  state.user = user;
  $('signin').hidden = true; $('loading').hidden = false;
  try {
    const invite = safeStorage.get('laxhq.invite');
    if (invite) {
      try { await call('acceptInvite', { code: invite }); } catch (e) {
        alert(`Couldn’t join with that invite: ${errorText(e)}`);
        await call('bootstrapFamily');
      }
      safeStorage.del('laxhq.invite');
      if (params.has('invite')) {
        params.delete('invite');
        history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash);
      }
    } else {
      await call('bootstrapFamily');
    }
    await refreshClaims();
    if (state.pendingName) { await call('updateMyName', { name: state.pendingName }).catch(() => {}); state.pendingName = null; }
    await loadConfig();
    const fid = state.claims.fid;
    state.playerId = safeStorage.get('laxhq.player');

    subscribe('family', onSnapshot(doc(db, `families/${fid}`), async (snap) => {
      state.family = snap.data() || null;
      const ent = JSON.stringify(state.family?.entitlement || null);
      if (state.lastEntitlement !== null && ent !== state.lastEntitlement) await refreshClaims(); // plan changed → new claims
      state.lastEntitlement = ent;
      state.loaded.family = true;
      markReady();
    }, (err) => { console.error(err); signinMsg('Could not load your family. Try signing in again.', true); }));

    subscribe('players', onSnapshot(query(collection(db, `families/${fid}/players`), orderBy('createdAt')), (snap) => {
      state.players = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (!state.players.some((p) => p.id === state.playerId)) state.playerId = state.players[0]?.id || null;
      watchPlayer();
      state.loaded.players = true;
      markReady();
    }, (err) => console.error('players', err)));
  } catch (e) {
    console.error(e);
    $('loading').hidden = true; showSignin(); signinMsg(errorText(e, 'Something went wrong signing in.'), true);
  }
}

onAuthStateChanged(auth, (user) => {
  unsubscribeAll();
  if (user) startSession(user);
  else {
    Object.assign(state, { user: null, claims: {}, family: null, players: [], playerId: null, checklist: null, lastEntitlement: null, ready: false, ui: {}, loaded: { family: false, players: false } });
    showSignin();
  }
});

// Exposed for automated tests only.
window.__laxhq = { state, can };
