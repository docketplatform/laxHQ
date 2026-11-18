// Highlights tab (#/highlights): LaxHQ's preferred highlight-reel partner, a request form that
// emails the partner directly, the family's past requests, and the path from reel → recruiting card.
import {
  collection, query, where, orderBy, limit, getDocs, doc, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { $, esc, formToObject, errorText, fmtDate } from '../util.js';
import { positionLabel } from '../lib/options.js';

let partnerCache = null;     // config/highlights, kept live
let partnerSub = null;
let mine = null;             // this family's requests
let mineFor = null;

function loadPartner(ctx) {
  if (partnerSub) return;
  const rerender = () => { if (location.hash.startsWith('#/highlights')) ctx.setUi('hlLoaded', Date.now()); };
  partnerSub = onSnapshot(doc(ctx.db, 'config/highlights'),
    (s) => { partnerCache = s.exists() ? s.data() : { active: false }; rerender(); },
    () => { partnerCache = { active: false }; rerender(); });
}

function loadMine(ctx) {
  const fid = ctx.state.claims.fid;
  if (!fid || mineFor === fid) return;
  mineFor = fid;
  getDocs(query(collection(ctx.db, 'highlightRequests'), where('fid', '==', fid), orderBy('createdAt', 'desc'), limit(10)))
    .then((s) => { mine = s.docs.map((d) => ({ id: d.id, ...d.data() })); if (location.hash.startsWith('#/highlights')) ctx.setUi('hlMine', Date.now()); })
    .catch(() => { mine = []; });
}


const STATUS = { new: 'Sent', contacted: 'Partner in touch', booked: 'Booked', done: 'Reel delivered', closed: 'Closed' };

function mailto(partner, d, player, parentName) {
  const who = player ? `${player.firstName} ${player.lastName}` : 'my player';
  const subject = `Highlight reel for ${who}${player?.gradYear ? ` (Class of ${player.gradYear})` : ''}`;
  const lines = [
    `Hi ${partner.name.split(' ')[0]},`,
    '',
    `I found you through LaxHQ and would like a highlight reel for ${who}.`,
    '',
    player ? `Player: ${who} · ${positionLabel(player.sport, player.position) || ''} · Class of ${player.gradYear || '?'}` : null,
    player?.club?.name ? `Club: ${player.club.name}${player.club.team ? ` ${player.club.team}` : ''}` : null,
    player?.highSchool?.name ? `High school: ${player.highSchool.name}` : null,
    d.neededBy ? `Needed by: ${d.neededBy}` : null,
    d.filmLinks ? `\nGame film:\n${d.filmLinks}` : null,
    d.message ? `\n${d.message}` : null,
    '',
    d.phone ? `Best number: ${d.phone}` : null,
    'Thanks,',
    parentName || '',
  ].filter((l) => l !== null);
  return `mailto:${encodeURIComponent(partner.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}

function view(ctx) {
  const p = partnerCache;
  const players = ctx.state.players || [];
  const cur = ctx.currentPlayer();
  const ui = ctx.state.ui;
  if (!p) return '<h1>Highlight reels</h1><p class="muted" role="status">Loading…</p>';

  const how = `<section class="card" id="hl-how">
      <h2>How it works</h2>
      <ol class="steps">
        <li><b>Send your film.</b> Full-game links from Hudl, YouTube, GameChanger or a shared folder.</li>
        <li><b>Get your reel.</b> A 3–4 minute reel, best plays first, with your player clearly marked.</li>
        <li><b>Put it on your card.</b> Paste the reel link into Film on the Profile tab and every coach who opens ${cur ? `${esc(cur.firstName)}’s` : 'your'} recruiting card sees it first.</li>
      </ol>
    </section>`;

  if (!p.active) {
    return `<h1>Highlight reels</h1>
      <section class="card hl-hero"><h2>Coaches watch film first</h2>
        <p>A strong highlight reel is the single most-opened part of a recruiting profile. We’re finishing setup with our preferred video editor. Check back soon.</p></section>
      ${how}
      ${ctx.state.isAdmin ? '<p class="small"><a href="#/admin/partner">Set up the highlight partner in Admin →</a></p>' : ''}`;
  }

  const sent = ui.hlSent;
  return `<h1>Highlight reels</h1>
    <section class="card hl-hero" id="hl-partner">
      <span class="chip c-likely" style="align-self:flex-start">LaxHQ preferred partner</span>
      <h2>${esc(p.business || p.name)}</h2>
      ${p.business && p.name ? `<p class="small">With ${esc(p.name)}</p>` : ''}
      ${p.tagline ? `<p class="lead">${esc(p.tagline)}</p>` : ''}
      <div class="fits">
        ${p.priceFrom ? `<span><span class="small">Price</span><b>${esc(p.priceFrom)}</b></span>` : ''}
        ${p.turnaround ? `<span><span class="small">Turnaround</span><b>${esc(p.turnaround)}</b></span>` : ''}
        ${p.familyOffer ? `<span><span class="small">LaxHQ families</span><b>${esc(p.familyOffer)}</b></span>` : ''}
      </div>
      ${p.about ? `<p>${esc(p.about).replace(/\n/g, '<br>')}</p>` : ''}
      ${p.includes ? `<div><b>What’s included</b><ul class="hl-list">${p.includes.split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}
      <div class="row start wrap">
        ${p.sampleUrl ? `<a class="btn btn-ghost btn-sm" href="${esc(p.sampleUrl)}" target="_blank" rel="noopener">Watch a sample reel ↗</a>` : ''}
        ${p.website ? `<a class="btn btn-ghost btn-sm" href="${esc(p.website)}" target="_blank" rel="noopener">Website ↗</a>` : ''}
        ${p.phone ? `<a class="btn btn-ghost btn-sm" href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">Call ${esc(p.phone)}</a>` : ''}
        ${p.email ? `<a class="btn btn-ghost btn-sm" href="mailto:${esc(p.email)}">Email ${esc(p.email)}</a>` : ''}
      </div>
      <p class="small">Priced and paid directly with ${esc(p.name)}. LaxHQ doesn’t charge for introductions.</p>
    </section>

    ${sent ? `<div class="banner ok-banner" role="status" id="hl-sent"><b>Request sent to ${esc(p.name)}.</b> ${p.email ? 'Your email app opened with everything filled in. Press send there, and he’ll reply to you directly.' : `He’ll be in touch, or call ${esc(p.phone || '')}.`}
      ${p.email && sent.mailto ? ` <a href="${esc(sent.mailto)}">Open the email again</a>` : ''}</div>` : ''}

    <form id="hl-form" class="card" data-keep novalidate>
      <h2>Request a reel</h2>
      ${players.length ? `<div class="field"><label for="hl-player">Player</label><select id="hl-player" name="playerId">${players.map((pl) => `<option value="${esc(pl.id)}"${pl.id === cur?.id ? ' selected' : ''}>${esc(pl.firstName)} ${esc(pl.lastName)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="hl-film">Game film links</label><textarea id="hl-film" name="filmLinks" maxlength="1500" placeholder="One link per line: Hudl, YouTube, GameChanger, Google Drive…"></textarea></div>
      <div class="two">
        <div class="field"><label for="hl-when">Needed by</label><input id="hl-when" name="neededBy" maxlength="40" placeholder="e.g. before summer showcases"></div>
        <div class="field"><label for="hl-phone">Your phone (optional)</label><input id="hl-phone" name="phone" type="tel" maxlength="30" autocomplete="tel"></div>
      </div>
      <div class="field"><label for="hl-msg">Anything else</label><textarea id="hl-msg" name="message" maxlength="1500" placeholder="Jersey number and color, games to focus on, plays you’re proud of"></textarea></div>
      <button class="btn btn-primary" type="submit"${ui.hlBusy ? ' disabled' : ''}>${p.email ? `Send request to ${esc(p.name.split(' ')[0])}` : 'Send request'}</button>
      <p class="small">${p.email ? 'Opens an email from you to the editor with these details. ' : ''}${esc(p.name)} works with you directly on price and timing.</p>
      ${ui.hlMsg ? `<p class="err" role="status">${esc(ui.hlMsg)}</p>` : ''}
    </form>

    ${how}
    <section class="card"><h2>Got your reel?</h2>
      <p class="small">Paste its link into <b>Film</b> on the Profile tab. It becomes the first thing coaches see on the recruiting card. Log what you paid under Spending (Highlight reels) so it counts in your recruiting total.</p>
      <div class="row start wrap"><a class="btn btn-dark btn-sm" href="#/profile">Add the reel link</a><a class="btn btn-ghost btn-sm" href="#/spend">Log the cost</a></div>
    </section>

    ${mine?.length ? `<section class="card" id="hl-mine"><h2>Your requests</h2><div class="list">${mine.map((r) => `<div><span class="grow"><b>${esc(r.player?.name || 'Reel request')}</b><br><span class="small">${r.createdAt ? fmtDate(r.createdAt.toDate()) : ''} · ${esc(r.partnerName || '')}</span></span><span class="chip c-muted">${esc(STATUS[r.status] || 'Sent')}</span></div>`).join('')}</div></section>` : ''}`;
}

export default {
  render(ctx) {
    loadPartner(ctx);
    loadMine(ctx);
    return view(ctx);
  },
  bind(ctx) {
    $('hl-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formToObject(e.target);
      if (!d.filmLinks && !d.message) { ctx.setUi('hlMsg', 'Add a film link or a note for the editor.'); return; }
      const player = (ctx.state.players || []).find((pl) => pl.id === d.playerId) || ctx.currentPlayer() || null;
      ctx.state.ui.hlBusy = true;
      try {
        await ctx.call('requestHighlights', { playerId: player?.id, filmLinks: d.filmLinks, neededBy: d.neededBy, message: d.message, phone: d.phone });
        const fam = ctx.state.family || {};
        const link = partnerCache.email ? mailto(partnerCache, d, player, fam.members?.[ctx.state.user.uid]?.name) : null;
        mineFor = null; loadMine(ctx);
        e.target.reset();
        e.target.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
        ctx.state.ui.hlBusy = false;
        ctx.setUi('hlSent', { mailto: link });
        if (link) window.location.href = link;
      } catch (err) {
        ctx.state.ui.hlBusy = false;
        ctx.setUi('hlMsg', errorText(err));
      }
    });
  },
};
