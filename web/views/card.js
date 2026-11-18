// Recruiting card: the public page coaches open (/c/<slug>) and the card section on the Profile tab.
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db, functionsBase } from '../firebase.js';
import { $, esc, fmtDate } from '../util.js';
import { positionLabel, STAT_LABELS, STATS_BY_POSITION } from '../lib/options.js';

const ORIGIN = location.origin;
export const cardUrl = (slug, token) => `${ORIGIN}/c/${slug}${token ? `?r=${encodeURIComponent(token)}` : ''}`;

/** Name shown on the card (cards built before names were configurable have no `name`). */
const cardTitle = (c) => c.name || `${c.firstName} ${c.lastInitial}.`;

/** The card itself, shared by the public page and the preview on the Profile tab. */
export function cardHtml(c) {
  const keys = [...(STATS_BY_POSITION[c.position] || []), ...Object.keys(c.stats || {})]
    .filter((k, i, a) => a.indexOf(k) === i && c.stats?.[k] != null).slice(0, 4);
  const statCells = keys.map((k) => `<div class="cs"><b>${esc(c.stats[k])}${k.endsWith('Pct') ? '%' : ''}</b><span>${esc(STAT_LABELS[k] || k)}</span></div>`);
  if (c.gpa != null) statCells.push(`<div class="cs"><b>${esc(c.gpa)}</b><span>GPA${c.gpaScale === 5 ? ' (5.0)' : ''}</span></div>`);
  return `<article class="rcard" aria-label="Recruiting card">
    ${c.filmUrl ? `<a class="rfilm" href="${esc(c.filmUrl)}" target="_blank" rel="noopener"><span class="play" aria-hidden="true"></span><span>Watch highlight film</span></a>`
    : '<div class="rfilm none"><span>Highlight film coming soon</span></div>'}
    <div class="rbody">
      <div class="row"><div><h1 class="rname">${esc(cardTitle(c))}</h1>
        <p class="rmeta">${esc(positionLabel(c.sport, c.position))} · Class of ${esc(c.gradYear)}${c.sport === 'wlax' ? ' · Women’s lacrosse' : ''}</p></div>
        ${c.jersey ? `<span class="rjersey">#${esc(c.jersey)}</span>` : ''}</div>
      ${statCells.length ? `<div class="rstats">${statCells.join('')}</div>${c.statsSeason ? `<p class="rmeta">Stats: ${esc(c.statsSeason)}</p>` : ''}` : ''}
      <dl class="rfacts">
        ${c.highSchool ? `<div><dt>High school</dt><dd>${esc(c.highSchool.name)}${c.highSchool.state ? `, ${esc(c.highSchool.state)}` : ''}</dd></div>` : ''}
        ${c.club ? `<div><dt>Club</dt><dd>${esc(c.club.name)}${c.club.team ? ` ${esc(c.club.team)}` : ''}</dd></div>` : ''}
        ${(c.summer || []).length ? `<div><dt>Summer</dt><dd>${c.summer.map((s) => esc(s)).join(' · ')}</dd></div>` : ''}
        ${(c.rankings || []).map((r) => `<div><dt>${esc(r.source)}</dt><dd>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.value)}</a>` : esc(r.value)} <span class="rself">self-reported</span></dd></div>`).join('')}
      </dl>
      ${c.contactEmail ? `<a class="btn btn-primary btn-block" href="mailto:${esc(c.contactEmail)}?subject=${encodeURIComponent(`${cardTitle(c)} · Class of ${c.gradYear}`)}">Contact the family</a>` : ''}
    </div>
  </article>`;
}

/** Public page: /c/<slug>?r=<token>. No sign-in. */
export async function renderPublicCard(slug) {
  const root = $('public');
  $('loading').hidden = true; $('signin').hidden = true; $('app').hidden = true; root.hidden = false;
  document.body.classList.add('public');
  let card = null;
  try { const s = await getDoc(doc(db, `cards/${slug}`)); card = s.exists() ? s.data() : null; } catch { card = null; }
  if (!card) {
    root.innerHTML = `<div class="pwrap"><div class="logo dark-logo">LAX<span>HQ</span></div><h1>This card isn’t available</h1>
      <p class="muted">The family may have turned off sharing. Ask them for a new link.</p></div>`;
    return;
  }
  document.title = `${cardTitle(card)} · Class of ${card.gradYear} · LaxHQ`;
  root.innerHTML = `<div class="pwrap">${cardHtml(card)}
    <p class="pfoot">Made with <a href="https://laxhq.netlify.app" rel="noopener">LaxHQ</a> · college recruiting game plan for lacrosse families</p></div>`;
  // Count the view. Runs only in a real browser, which keeps most email link scanners out.
  const token = new URLSearchParams(location.search).get('r');
  fetch(`${functionsBase}/cardView`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, r: token || undefined }), keepalive: true,
  }).catch(() => {});
}

/** Card section on the Profile tab (Pro). */
export function cardSectionHtml(ctx, p) {
  const st = p.cardStats || {};
  const ui = ctx.state.ui;
  const url = cardUrl(p.cardSlug);
  return `<section class="card" id="card-section">
    <div class="row"><h2>Recruiting card</h2><span class="chip ${p.cardPublished ? 'c-likely' : 'c-muted'}">${p.cardPublished ? 'Live link' : 'Off'}</span></div>
    <p class="small">One link with film, stats, GPA and summer schedule.</p>
    <label class="check" style="align-self:flex-start"><input type="checkbox" id="card-publish"${p.cardPublished ? ' checked' : ''}> Share ${esc(p.firstName)}’s card</label>
    <div class="field"><label for="card-name">Name on the card</label><select id="card-name">
      <option value="full"${p.cardNameStyle !== 'initial' ? ' selected' : ''}>Full name (${esc(`${p.firstName} ${p.lastName}`)})</option>
      <option value="initial"${p.cardNameStyle === 'initial' ? ' selected' : ''}>First name and last initial (${esc(`${p.firstName} ${(p.lastName || '').slice(0, 1)}.`)})</option>
    </select></div>
    ${p.cardPublished ? `
      <div class="copy"><input id="card-link" readonly value="${esc(url)}" aria-label="Card link"><button class="btn btn-primary" id="copy-card">Copy</button></div>
      <div class="row start wrap"><a class="btn btn-ghost btn-sm" href="${esc(url)}" target="_blank" rel="noopener">Open card</a><button class="btn btn-ghost btn-sm" id="print-card">Export PDF</button></div>
      <div class="fits" id="card-stats"><span><span class="small">Views, 30 days</span><b>${st.views30d || 0}</b></span><span><span class="small">From coach emails</span><b>${st.tokenViews || 0}</b></span><span><span class="small">Last viewed</span><b>${st.lastViewAt ? fmtDate(st.lastViewAt.toDate ? st.lastViewAt.toDate() : st.lastViewAt) : '—'}</b></span></div>
      ${(st.recentSchools || []).length ? `<p class="small">Recently viewed by <b>${st.recentSchools.map(esc).join(' · ')}</b></p>` : '<p class="small">Views from links in your coach emails show the school here.</p>'}` : ''}
    <p id="card-msg" class="${ui.cardMsg?.bad ? 'err' : 'ok'}" role="status" aria-live="polite">${esc(ui.cardMsg?.text || '')}</p>
  </section>`;
}

export function bindCardSection(ctx) {
  $('card-publish')?.addEventListener('change', async (e) => {
    try {
      await ctx.call('updatePlayer', { playerId: ctx.currentPlayer().id, cardPublished: e.target.checked });
      ctx.setUi('cardMsg', { text: e.target.checked ? 'Your card is live.' : 'Sharing is off. Old links now show “not available”.' });
    } catch (err) { e.target.checked = !e.target.checked; ctx.setUi('cardMsg', { text: err.message, bad: true }); }
  });
  $('card-name')?.addEventListener('change', async (e) => {
    try {
      await ctx.call('updatePlayer', { playerId: ctx.currentPlayer().id, cardNameStyle: e.target.value });
      ctx.setUi('cardMsg', { text: e.target.value === 'full' ? 'The card now shows the full name.' : 'The card now shows the first name and last initial.' });
    } catch (err) { ctx.setUi('cardMsg', { text: err.message, bad: true }); }
  });
  $('copy-card')?.addEventListener('click', async () => {
    $('card-link').select();
    try { await navigator.clipboard.writeText($('card-link').value); ctx.setUi('cardMsg', { text: 'Link copied.' }); } catch { ctx.setUi('cardMsg', { text: 'Select the link and copy it.' }); }
  });
  $('print-card')?.addEventListener('click', () => window.open(`${cardUrl(ctx.currentPlayer().cardSlug)}?print=1`, '_blank'));
}
