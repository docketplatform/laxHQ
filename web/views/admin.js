// Platform admin area (#/admin, #/admin/requests, #/admin/partner). Only for logins in admins/{uid};
// every action is checked again on the server.
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { $, esc, formToObject, errorText, fmtDate } from '../util.js';
import { positionLabel } from '../lib/options.js';

let data = null;
let loading = false;
let loadError = null;
let partner = null;

function load(ctx, force = false) {
  if (loading || (data && !force)) return;
  loading = true; loadError = null;
  Promise.all([
    ctx.call('adminOverview'),
    getDoc(doc(ctx.db, 'config/highlights')).then((s) => (s.exists() ? s.data() : {})),
  ]).then(([d, p]) => { data = d; partner = p; })
    .catch((e) => { loadError = errorText(e); })
    .finally(() => { loading = false; if (location.hash.startsWith('#/admin')) ctx.setUi('adminLoaded', Date.now()); });
}

const when = (s) => (s ? fmtDate(s, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const planChip = (f) => (f.plan === 'pro'
  ? `<span class="chip c-likely">Pro${f.source === 'org' ? ' · comp' : f.source === 'stripe' ? ' · paid' : f.source === 'revenuecat' ? ' · iOS' : ''}</span>`
  : '<span class="chip c-muted">Free</span>');
const REQ_STATUS = [['new', 'New'], ['contacted', 'Contacted'], ['booked', 'Booked'], ['done', 'Delivered'], ['closed', 'Closed']];

function familiesView(ctx) {
  const q = (ctx.state.ui.adminQuery || '').toLowerCase().trim();
  const match = (f) => !q || [f.name, ...f.members.flatMap((m) => [m.name, m.email]), ...f.players.flatMap((p) => [p.firstName, p.lastName, p.club, p.highSchool])]
    .some((v) => v && String(v).toLowerCase().includes(q));
  const list = data.families.filter(match);
  return `<div class="field"><label for="admin-q">Search families, parents, players, clubs</label><input id="admin-q" type="search" value="${esc(ctx.state.ui.adminQuery || '')}" autocomplete="off"></div>
    <p class="small">${list.length} of ${data.families.length} families</p>
    ${list.map((f) => `<section class="card admin-fam">
      <div class="row"><span><b>${esc(f.name || 'Unnamed family')}</b><br><span class="small">Joined ${when(f.createdAt)}</span></span>${planChip(f)}</div>
      <div><span class="small">Accounts</span>
        ${f.members.map((m) => `<div class="admin-line"><b>${esc(m.name || '—')}</b> · ${m.role === 'player' ? 'Player' : 'Parent'}${m.owner ? ' (owner)' : ''}<br><span class="small">${m.email ? `<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : 'no email'} · last sign-in ${when(m.lastSignInAt)}</span></div>`).join('')}
      </div>
      <div><span class="small">Players</span>
        ${f.players.length ? f.players.map((p) => `<div class="admin-line"><b>${esc(p.firstName)} ${esc(p.lastName)}</b> · ${esc(positionLabel(p.sport, p.position) || '')} · Class of ${esc(p.gradYear || '?')}<br><span class="small">${esc([p.club, p.highSchool].filter(Boolean).join(' · ') || 'No club or school yet')} · ${p.targetCount} schools · card ${p.cardPublished ? 'live' : 'off'} · film ${p.hasFilm ? 'yes' : 'no'}</span></div>`).join('') : '<div class="small">No players yet</div>'}
      </div>
    </section>`).join('')}
    ${data.accountsWithoutFamily.length ? `<section class="card"><h2>Logins without a family</h2><p class="small">Signed in but never finished setup.</p><div class="list">${data.accountsWithoutFamily.map((a) => `<div><span class="grow"><b>${esc(a.name || a.email || a.uid)}</b><br><span class="small">${esc(a.email || '')} · created ${when(a.createdAt)}</span></span></div>`).join('')}</div></section>` : ''}`;
}

function requestsView() {
  if (!data.requests.length) return '<div class="card"><p class="muted">No highlight reel requests yet.</p></div>';
  return data.requests.map((r) => `<section class="card">
    <div class="row"><span><b>${esc(r.player?.name || 'Reel request')}</b>${r.player?.gradYear ? ` · Class of ${esc(r.player.gradYear)}` : ''}<br><span class="small">${when(r.createdAt)} · ${esc(r.familyName || '')}</span></span>
      <select data-req="${esc(r.id)}" aria-label="Status">${REQ_STATUS.map(([v, l]) => `<option value="${v}"${r.status === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <p class="small">${esc(r.parentName || '')}${r.email ? ` · <a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : ''}${r.phone ? ` · ${esc(r.phone)}` : ''}${r.neededBy ? ` · needed by ${esc(r.neededBy)}` : ''}</p>
    ${r.filmLinks ? `<p class="small wrapword">${esc(r.filmLinks).replace(/\n/g, '<br>')}</p>` : ''}
    ${r.message ? `<p class="small">${esc(r.message).replace(/\n/g, '<br>')}</p>` : ''}
  </section>`).join('');
}

function partnerView(ctx) {
  const p = partner || {};
  const msg = ctx.state.ui.partnerMsg;
  const f = (name, label, opts = {}) => `<div class="field"><label for="pt-${name}">${label}</label>${opts.area
    ? `<textarea id="pt-${name}" name="${name}" maxlength="${opts.max || 1500}" placeholder="${esc(opts.ph || '')}">${esc(p[name] || '')}</textarea>`
    : `<input id="pt-${name}" name="${name}" maxlength="${opts.max || 140}" value="${esc(p[name] || '')}" placeholder="${esc(opts.ph || '')}"${opts.type ? ` type="${opts.type}"` : ''}>`}</div>`;
  return `<form id="partner-form" class="card" data-keep novalidate>
    <h2>Highlight reel partner</h2>
    <p class="small">Every family sees this on the Highlights tab. Requests email the partner directly and show up under Reel requests here.</p>
    <label class="check" style="align-self:flex-start"><input type="checkbox" name="active"${p.active ? ' checked' : ''}> Show the partner to families</label>
    <div class="two">${f('name', 'Editor’s name', { max: 80 })}${f('business', 'Business name', { max: 80 })}</div>
    ${f('tagline', 'One-line pitch', { ph: 'Recruiting reels that get coaches to the phone' })}
    <div class="two">${f('email', 'Email', { type: 'email', max: 120 })}${f('phone', 'Phone', { type: 'tel', max: 30 })}</div>
    <div class="two">${f('website', 'Website', { type: 'url', max: 300, ph: 'https://' })}${f('sampleUrl', 'Sample reel link', { type: 'url', max: 300, ph: 'https://' })}</div>
    <div class="three">${f('priceFrom', 'Price', { max: 60, ph: 'From $250' })}${f('turnaround', 'Turnaround', { max: 60, ph: '5–7 days' })}${f('familyOffer', 'LaxHQ family offer', { max: 140, ph: '10% off' })}</div>
    ${f('about', 'About', { area: true })}
    ${f('includes', 'What’s included (one per line)', { area: true, max: 800 })}
    <button class="btn btn-primary" type="submit">Save partner</button>
    ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
  </form>`;
}

export default {
  tab: 'admin',
  render(ctx, args) {
    if (!ctx.state.isAdmin) return '<h1>Admin</h1><p class="muted">This area is for the LaxHQ team.</p>';
    load(ctx);
    const section = args[0] === 'requests' ? 'requests' : args[0] === 'partner' ? 'partner' : 'families';
    const t = data?.totals;
    return `<div class="row"><h1>Admin</h1><button class="btn btn-ghost btn-sm" id="admin-refresh"${loading ? ' disabled' : ''}>Refresh</button></div>
      ${t ? `<div class="fits admin-totals"><span><span class="small">Families</span><b>${t.families}</b></span><span><span class="small">Pro</span><b>${t.proFamilies}</b></span><span><span class="small">Players</span><b>${t.players}</b></span><span><span class="small">Logins</span><b>${t.accounts}</b></span><span><span class="small">Reel requests</span><b>${t.highlightRequests}</b></span></div>` : ''}
      <div class="seg" role="tablist" aria-label="Admin sections">
        ${[['families', 'Families', '#/admin'], ['requests', 'Reel requests', '#/admin/requests'], ['partner', 'Highlight partner', '#/admin/partner']]
    .map(([k, l, h]) => `<button role="tab" aria-selected="${k === section}" data-go="${h}">${l}</button>`).join('')}
      </div>
      ${loadError ? `<p class="err" role="status">${esc(loadError)}</p>` : ''}
      ${!data ? (loadError ? '' : '<p class="muted" role="status">Loading…</p>')
    : section === 'requests' ? requestsView() : section === 'partner' ? partnerView(ctx) : familiesView(ctx)}
      ${data ? `<p class="small">Updated ${new Date(data.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>` : ''}`;
  },
  bind(ctx) {
    if (!ctx.state.isAdmin) return;
    document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => ctx.navigate(b.dataset.go)));
    $('admin-refresh')?.addEventListener('click', () => { load(ctx, true); ctx.setUi('adminLoading', Date.now()); });
    const q = $('admin-q');
    if (q) { let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => ctx.setUi('adminQuery', q.value), 150); }); }
    document.querySelectorAll('[data-req]').forEach((s) => s.addEventListener('change', async () => {
      try {
        await ctx.call('adminUpdateHighlightRequest', { id: s.dataset.req, status: s.value });
        const r = data.requests.find((x) => x.id === s.dataset.req); if (r) r.status = s.value;
      } catch (err) { alert(errorText(err)); }
    }));
    $('partner-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formToObject(e.target);
      d.active = e.target.elements.active.checked;
      try {
        await ctx.call('adminSaveHighlightPartner', d);
        partner = { ...partner, ...d };
        e.target.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
        ctx.setUi('partnerMsg', { text: d.active ? 'Saved. Families now see this partner on the Highlights tab.' : 'Saved. The partner is hidden from families.' });
      } catch (err) { ctx.setUi('partnerMsg', { text: errorText(err), bad: true }); }
    });
  },
};
