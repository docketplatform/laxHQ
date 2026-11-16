// Profile tab: the player's profile, then the family (members, invites, plan).
import { $, esc, formToObject, errorText } from '../util.js';
import { playerFormHtml, cleanPlayerInput, quickCheck, bindSportSwitch } from './playerForm.js';
import { playerSwitcher, bindSwitcher } from './home.js';
import { cardSectionHtml, bindCardSection } from './card.js';

function familyHtml(ctx) {
  const { state } = ctx;
  const fam = state.family || {};
  const members = Object.entries(fam.members || {});
  const me = state.user;
  const ui = state.ui;
  const myName = fam.members?.[me.uid]?.name || '';
  const ent = fam.entitlement || {};
  return `<h1 id="family">Family</h1>
    <div class="card">
      <div class="field"><label for="my-name">Your name</label>
        <div class="copy"><input id="my-name" value="${esc(myName)}" maxlength="80" autocomplete="name"><button class="btn btn-ghost" id="save-my-name">Save</button></div></div>
      <p id="my-name-msg" class="${ui.myNameMsg?.bad ? 'err' : 'ok'}" role="status" aria-live="polite">${esc(ui.myNameMsg?.text || '')}</p>
      <div class="field"><label for="fam-name">Family name</label>
        <div class="copy"><input id="fam-name" value="${esc(fam.name || '')}" maxlength="80"><button class="btn btn-ghost" id="save-name">Save</button></div></div>
      <p id="name-msg" class="${ui.nameMsg?.bad ? 'err' : 'ok'}" role="status" aria-live="polite">${esc(ui.nameMsg?.text || '')}</p>
    </div>
    <div class="card"><h2>Members</h2><div class="list" id="members">${members.map(([uid, m]) => `
      <div><span class="avatar" aria-hidden="true">${esc((m.name || '?').slice(0, 1).toUpperCase())}</span>
      <span><b>${esc(m.name)}${uid === me.uid ? ' (you)' : ''}</b><br><span class="small">${m.role === 'player' ? 'Player' : 'Parent'}</span></span></div>`).join('')}
    </div></div>
    <div class="card"><h2>Invite your family</h2>
      <p class="small">Send a link to a co-parent or your player. Each link works once and expires in 7 days.</p>
      <div class="row start wrap">
        <button class="btn btn-dark" data-invite="parent">Invite a parent</button>
        <button class="btn btn-ghost" data-invite="player">Invite your player</button>
      </div>
      <div id="invite-out" ${ui.inviteLink ? '' : 'hidden'} class="field"><label for="invite-link">Invite link</label>
        <div class="copy"><input id="invite-link" readonly value="${esc(ui.inviteLink || '')}"><button class="btn btn-primary" id="copy-invite">Copy</button></div></div>
      <p id="invite-msg" class="${ui.inviteMsg?.bad ? 'err' : 'small'}" role="status" aria-live="polite">${esc(ui.inviteMsg?.text || '')}</p>
    </div>
    <div class="card" id="plan-card"><div class="row"><span><b>Plan: ${ctx.isPro() ? 'Pro' : 'Free'}</b><br>
      <span class="small">${ctx.isPro()
    ? `Covers ${ent.maxPlayers || 1} player${(ent.maxPlayers || 1) > 1 ? 's' : ''}. You can enter and save your players’ information.`
    : 'Free accounts can look around with a sample family.'}</span></span></div>
      <div id="billing-actions">${billingActions(ctx)}</div>
      ${ui.billingMsg ? `<p class="${ui.billingMsg.bad ? 'err' : 'small'}" role="status">${esc(ui.billingMsg.text)}</p>` : ''}
      ${ctx.USE_EMULATORS ? `<div class="dev"><b>Emulator only</b><div class="row start wrap">
        <button class="btn btn-ghost" data-dev-plan="pro">Switch to Pro</button>
        <button class="btn btn-ghost" data-dev-plan="pro2">Pro + sibling</button>
        <button class="btn btn-ghost" data-dev-plan="free">Switch to Free</button></div></div>` : ''}
    </div>
    <p class="small">Signed in as ${esc(me.email || me.displayName || '')}</p>
    <button class="btn btn-ghost" id="sign-out">Sign out</button>
    <section class="card" id="danger">
      <h2>Delete account</h2>
      ${fam.ownerUid === me.uid ? `<p class="small">Deleting the family removes every player, plan, school list, coach, card, expense and receipt, cancels a web subscription, and can’t be undone. Other members keep their logins and start fresh.</p>
        <button class="btn btn-ghost danger" data-delete="family">Delete the family and all its data</button>` : ''}
      ${members.length > 1 ? `<p class="small">Or remove only your own login and leave the family. Everything else stays.</p>
        <button class="btn btn-ghost danger" data-delete="me">Delete my login only</button>`
    : (fam.ownerUid === me.uid ? '' : '<button class="btn btn-ghost danger" data-delete="me">Delete my account</button>')}
      <p id="delete-msg" class="${ui.deleteMsg?.bad ? 'err' : 'small'}" role="status" aria-live="polite">${esc(ui.deleteMsg?.text || '')}</p>
    </section>
    <p class="small links"><a href="/help.html">Help</a> · <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a></p>`;
}

/** Billing: Start Pro (Stripe Checkout) or Manage billing (Stripe Customer Portal). */
export function billingActions(ctx) {
  const ent = ctx.state.family?.entitlement || {};
  const busy = ctx.state.ui.billingBusy;
  if (ctx.isPro()) {
    if (ent.source === 'stripe') {
      return `${ent.status === 'past_due' ? '<p class="err">Your last payment didn’t go through. Update your card to keep Pro.</p>' : ''}
        <button class="btn btn-ghost" id="manage-billing"${busy ? ' disabled' : ''}>Manage billing</button>
        <p class="small">Change plan, add siblings, update your card, download invoices or cancel.</p>`;
    }
    if (ent.source === 'revenuecat') return '<p class="small">Your subscription is through the App Store. Manage it in your iPhone’s Settings → Apple ID → Subscriptions.</p>';
    return '';
  }
  return `<div class="plans">
      <div class="planopt"><b>$500 / year</b><span class="small">Best value</span>
        <div class="field"><label for="siblings">Siblings (+$99/year each)</label><select id="siblings">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n === 0 ? 'None' : n}</option>`).join('')}</select></div>
        <button class="btn btn-primary" data-checkout="year"${busy ? ' disabled' : ''}>Start Pro yearly</button></div>
      <div class="planopt"><b>$49 / month</b><span class="small">Cancel any time</span>
        <button class="btn btn-ghost" data-checkout="month"${busy ? ' disabled' : ''}>Start Pro monthly</button></div>
    </div>
    <p class="small">Secure checkout by Stripe. Highlight reels are a separate charge through our editing partner.</p>`;
}

function bindFamily(ctx) {
  const { setUi } = ctx;
  $('save-my-name')?.addEventListener('click', async () => {
    const name = $('my-name').value.replace(/\s+/g, ' ').trim();
    if (!name) { setUi('myNameMsg', { text: 'Enter your name.', bad: true }); return; }
    try { await ctx.call('updateMyName', { name }); setUi('myNameMsg', { text: 'Saved.' }); } catch (e) { setUi('myNameMsg', { text: errorText(e), bad: true }); }
  });
  $('save-name')?.addEventListener('click', async () => {
    const name = $('fam-name').value.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) { setUi('nameMsg', { text: 'Enter a family name.', bad: true }); return; }
    const { doc, updateDoc } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
    try { await updateDoc(doc(ctx.db, `families/${ctx.state.claims.fid}`), { name }); setUi('nameMsg', { text: 'Saved.' }); } catch { setUi('nameMsg', { text: 'Could not save. Try again.', bad: true }); }
  });
  document.querySelectorAll('[data-invite]').forEach((b) => b.addEventListener('click', async () => {
    setUi('inviteMsg', { text: 'Creating link…' });
    try {
      const { code } = await ctx.call('createInvite', { role: b.dataset.invite });
      const url = new URL(location.href); url.hash = ''; url.search = ''; url.searchParams.set('invite', code);
      if (ctx.USE_EMULATORS) url.searchParams.set('emulator', '1');
      ctx.state.ui.inviteLink = url.toString();
      setUi('inviteMsg', { text: `Link for your ${b.dataset.invite} is ready.` });
    } catch (e) { setUi('inviteMsg', { text: errorText(e, 'Could not create a link.'), bad: true }); }
  }));
  $('copy-invite')?.addEventListener('click', async () => {
    const input = $('invite-link'); input.select();
    try { await navigator.clipboard.writeText(input.value); setUi('inviteMsg', { text: 'Copied.' }); } catch { setUi('inviteMsg', { text: 'Select the link and copy it.' }); }
  });
  document.querySelectorAll('[data-checkout]').forEach((b) => b.addEventListener('click', async () => {
    const siblings = b.dataset.checkout === 'year' ? Number($('siblings').value) : 0; // read before the re-render below
    ctx.state.ui.billingBusy = true; setUi('billingMsg', { text: 'Opening secure checkout…' });
    try {
      const { url } = await ctx.call('createCheckout', { interval: b.dataset.checkout, siblings, appOrigin: location.origin });
      location.assign(url);
    } catch (e) { ctx.state.ui.billingBusy = false; setUi('billingMsg', { text: errorText(e), bad: true }); }
  }));
  $('manage-billing')?.addEventListener('click', async () => {
    ctx.state.ui.billingBusy = true; setUi('billingMsg', { text: 'Opening billing…' });
    try { const { url } = await ctx.call('createPortal', { appOrigin: location.origin }); location.assign(url); } catch (e) { ctx.state.ui.billingBusy = false; setUi('billingMsg', { text: errorText(e), bad: true }); }
  });
  document.querySelectorAll('[data-dev-plan]').forEach((b) => b.addEventListener('click', async () => {
    const v = b.dataset.devPlan;
    await ctx.call('devSetPlan', { plan: v === 'free' ? 'free' : 'pro', maxPlayers: v === 'pro2' ? 2 : 1 });
    await ctx.refreshClaims();
  }));
  $('sign-out')?.addEventListener('click', () => ctx.signOut());
  document.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    const family = b.dataset.delete === 'family';
    const typed = prompt(family
      ? 'This deletes your whole family’s LaxHQ data and can’t be undone. Type DELETE to confirm.'
      : 'This deletes your login. Type DELETE to confirm.');
    if (typed !== 'DELETE') { setUi('deleteMsg', { text: 'Nothing was deleted.' }); return; }
    setUi('deleteMsg', { text: 'Deleting…' });
    try {
      await ctx.call('deleteAccount', { scope: family ? 'family' : 'me' });
      await ctx.signOut();
    } catch (e) { setUi('deleteMsg', { text: errorText(e), bad: true }); }
  }));
}

export default {
  render(ctx) {
    const p = ctx.currentPlayer();
    let playerPart = '';
    if (ctx.isPro() && p) {
      const msg = ctx.state.ui.profileMsg;
      playerPart = `${playerSwitcher(ctx)}
        <div class="row"><h1>${esc(p.firstName)}’s profile</h1>${ctx.can('addPlayer') || ctx.state.players.length > 0 ? '<a class="btn btn-ghost btn-sm" href="#/onboarding">Add a sibling</a>' : ''}</div>
        ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
        ${cardSectionHtml(ctx, p)}
        ${playerFormHtml(p, { id: 'profile-form', full: true, submitLabel: 'Save profile' })}`;
    } else if (ctx.isPro()) {
      playerPart = '<div class="card"><h2>No player yet</h2><a class="btn btn-primary" href="#/onboarding">Set up my player</a></div>';
    }
    return playerPart + familyHtml(ctx);
  },
  bind(ctx) {
    bindSwitcher(ctx); bindFamily(ctx); bindCardSection(ctx);
    const form = $('profile-form');
    if (!form) return;
    bindSportSwitch('profile-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('profile-form-msg');
      const data = cleanPlayerInput(formToObject(form));
      const problem = quickCheck(data);
      if (problem) { msg.className = 'err'; msg.textContent = problem; return; }
      e.submitter.disabled = true; msg.className = 'small'; msg.textContent = 'Saving…';
      try {
        await ctx.call('updatePlayer', { playerId: ctx.currentPlayer().id, ...data });
        form.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
        ctx.setUi('profileMsg', { text: 'Profile saved.' });
      } catch (err) {
        e.submitter.disabled = false; msg.className = 'err'; msg.textContent = errorText(err);
      }
    });
  },
};
