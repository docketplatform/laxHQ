// Recruiting card: the public page coaches open (/c/<slug>) and the card section on the Profile tab.
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db, functionsBase } from '../firebase.js';
import { $, esc, fmtDate } from '../util.js';
import { positionLabel, STAT_LABELS, STATS_BY_POSITION } from '../lib/options.js';
import { videoEmbed, PROVIDER_LABEL, VIDEO_KINDS } from '../lib/video.js';

const ORIGIN = location.origin;
export const cardUrl = (slug, token) => `${ORIGIN}/c/${slug}${token ? `?r=${encodeURIComponent(token)}` : ''}`;

/** Name shown on the card (cards built before names were configurable have no `name`). */
const cardTitle = (c) => c.name || `${c.firstName} ${c.lastInitial}.`;

const kindLabel = (k) => VIDEO_KINDS.find((x) => x.value === k)?.label || 'Video';
const cardVideosOf = (c) => (c.videos?.length ? c.videos : c.filmUrl ? [{ title: 'Highlight reel', url: c.filmUrl, kind: 'highlight' }] : []);

/** The main player (click to load, so nothing plays or tracks until someone presses play) and the video list. */
function videosHtml(c) {
  const list = cardVideosOf(c);
  if (!list.length) return '<div class="rfilm none"><span>Highlight film coming soon</span></div>';
  const main = list[0];
  const e = videoEmbed(main.url);
  return `<div class="rplayer" id="rplayer" data-v="0">${playerFace(main, e)}</div>
    ${list.length > 1 ? `<div class="rvideos" role="list" aria-label="More videos">${list.map((v, i) => `<button class="rvid${i === 0 ? ' on' : ''}" role="listitem" data-v="${i}" aria-label="Play ${esc(v.title || kindLabel(v.kind))}">
      <span class="rvid-play" aria-hidden="true"></span><span><b>${esc(v.title || kindLabel(v.kind))}</b><span>${esc(kindLabel(v.kind))} · ${esc(PROVIDER_LABEL[videoEmbed(v.url).provider])}</span></span></button>`).join('')}</div>` : ''}
    <div class="print-only rprint">${list.map((v) => `<p><b>${esc(v.title || kindLabel(v.kind))}:</b> ${esc(v.url)}</p>`).join('')}</div>`;
}

function playerFace(v, e) {
  const label = esc(v.title || kindLabel(v.kind));
  if (!e.embedUrl) {
    return `<a class="rfilm" href="${esc(e.watchUrl)}" target="_blank" rel="noopener" data-play-link><span class="play" aria-hidden="true"></span><span>Watch ${label} on ${esc(PROVIDER_LABEL[e.provider])} ↗</span></a>`;
  }
  return `<button class="rfilm rface" data-play ${e.thumb ? `style="background-image:linear-gradient(rgba(14,27,44,.35),rgba(14,27,44,.55)),url('${esc(e.thumb)}')"` : ''}>
    <span class="play" aria-hidden="true"></span><span>Play ${label}</span></button>`;
}

/**
 * Wire up the card's videos. onPlay(index) is called once per video when it starts
 * (the public page uses it to count plays; the Profile preview passes nothing).
 */
export function bindVideos(c, onPlay) {
  const list = cardVideosOf(c);
  const box = $('rplayer');
  if (!box || !list.length) return;
  const played = new Set();
  const start = (i, autoplay) => {
    const v = list[i]; const e = videoEmbed(v.url);
    box.dataset.v = String(i);
    document.querySelectorAll('.rvid').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === i));
    if (!autoplay) { box.innerHTML = playerFace(v, e); bindFace(); return; }
    if (!played.has(i)) { played.add(i); onPlay?.(i); }
    if (!e.embedUrl) return;
    const auto = e.provider === 'youtube' || e.provider === 'vimeo' ? `${e.embedUrl.includes('?') ? '&' : '?'}autoplay=1` : '';
    box.innerHTML = `<iframe src="${esc(e.embedUrl + auto)}" title="${esc(v.title || kindLabel(v.kind))}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  };
  const bindFace = () => {
    box.querySelector('[data-play]')?.addEventListener('click', () => start(Number(box.dataset.v), true));
    box.querySelector('[data-play-link]')?.addEventListener('click', () => { const i = Number(box.dataset.v); if (!played.has(i)) { played.add(i); onPlay?.(i); } });
  };
  bindFace();
  document.querySelectorAll('.rvid').forEach((b) => b.addEventListener('click', () => {
    const i = Number(b.dataset.v); const e = videoEmbed(list[i].url);
    if (e.embedUrl) start(i, true); else { start(i, false); window.open(e.watchUrl, '_blank', 'noopener'); if (!played.has(i)) { played.add(i); onPlay?.(i); } }
  }));
}

const fmtDay = (s) => new Date(`${s}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
/** "Jun 20–22", "Jun 30–Jul 2", or "Jul 12". */
function dayRange(start, end) {
  if (!end || end === start) return fmtDay(start);
  return start.slice(0, 7) === end.slice(0, 7) ? `${fmtDay(start)}–${Number(end.slice(8, 10))}` : `${fmtDay(start)}–${fmtDay(end)}`;
}
function eventsHtml(c) {
  const today = new Date().toISOString().slice(0, 10);
  const up = (c.events || []).filter((e) => (e.end || e.start) >= today).slice(0, 6);
  if (!up.length) return '';
  return `<div class="revents"><h2 class="rh">Where to see ${esc(c.firstName)}</h2>${up.map((e) => `<div class="revent">
    <span class="rdate">${esc(dayRange(e.start, e.end))}</span>
    <span><b>${esc(e.title)}</b>${e.city ? `<br><span class="rmeta">${esc(e.city)}${e.state ? `, ${esc(e.state)}` : ''}</span>` : ''}</span></div>`).join('')}</div>`;
}

/** The card itself, shared by the public page and the preview on the Profile tab. */
export function cardHtml(c) {
  const keys = [...(STATS_BY_POSITION[c.position] || []), ...Object.keys(c.stats || {})]
    .filter((k, i, a) => a.indexOf(k) === i && c.stats?.[k] != null).slice(0, 4);
  const statCells = keys.map((k) => `<div class="cs"><b>${esc(c.stats[k])}${k.endsWith('Pct') ? '%' : ''}</b><span>${esc(STAT_LABELS[k] || k)}</span></div>`);
  if (c.gpa != null) statCells.push(`<div class="cs"><b>${esc(c.gpa)}</b><span>GPA${c.gpaScale === 5 ? ' (5.0)' : ''}</span></div>`);
  return `<article class="rcard" aria-label="Recruiting card">
    ${videosHtml(c)}
    <div class="rbody">
      <div class="row"><div><h1 class="rname">${esc(cardTitle(c))}</h1>
        <p class="rmeta">${esc(positionLabel(c.sport, c.position))} · Class of ${esc(c.gradYear)}${c.sport === 'wlax' ? ' · Women’s lacrosse' : ''}</p></div>
        ${c.jersey ? `<span class="rjersey">#${esc(c.jersey)}</span>` : ''}</div>
      ${statCells.length ? `<div class="rstats">${statCells.join('')}</div>${c.statsSeason ? `<p class="rmeta">Stats: ${esc(c.statsSeason)}</p>` : ''}` : ''}
      <dl class="rfacts">
        ${c.highSchool ? `<div><dt>High school</dt><dd>${esc(c.highSchool.name)}${c.highSchool.state ? `, ${esc(c.highSchool.state)}` : ''}</dd></div>` : ''}
        ${c.club ? `<div><dt>Club</dt><dd>${esc(c.club.name)}${c.club.team ? ` ${esc(c.club.team)}` : ''}</dd></div>` : ''}
        ${(c.summer || []).length && !(c.events || []).length ? `<div><dt>Summer</dt><dd>${c.summer.map((s) => esc(s)).join(' · ')}</dd></div>` : ''}
        ${(c.rankings || []).map((r) => `<div><dt>${esc(r.source)}</dt><dd>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.value)}</a>` : esc(r.value)} <span class="rself">self-reported</span></dd></div>`).join('')}
      </dl>
      ${eventsHtml(c)}
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
  bindVideos(card, (v) => fetch(`${functionsBase}/cardView`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, r: token || undefined, event: 'video', v }), keepalive: true,
  }).catch(() => {}));
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
    <p class="small">One link with film that plays right on the card, stats, GPA and where to see ${esc(p.firstName)} play.${p.filmUrl || (p.videos || []).length ? '' : ' <b>No highlight film yet:</b> <a href="#/highlights">get a reel made</a>, then paste its link into Videos above.'}</p>
    <label class="check" style="align-self:flex-start"><input type="checkbox" id="card-publish"${p.cardPublished ? ' checked' : ''}> Share ${esc(p.firstName)}’s card</label>
    <div class="field"><label for="card-name">Name on the card</label><select id="card-name">
      <option value="full"${p.cardNameStyle !== 'initial' ? ' selected' : ''}>Full name (${esc(`${p.firstName} ${p.lastName}`)})</option>
      <option value="initial"${p.cardNameStyle === 'initial' ? ' selected' : ''}>First name and last initial (${esc(`${p.firstName} ${(p.lastName || '').slice(0, 1)}.`)})</option>
    </select></div>
    ${p.cardPublished ? `
      <div class="copy"><input id="card-link" readonly value="${esc(url)}" aria-label="Card link"><button class="btn btn-primary" id="copy-card">Copy</button></div>
      <div class="row start wrap"><a class="btn btn-ghost btn-sm" href="${esc(url)}" target="_blank" rel="noopener">Open card</a><button class="btn btn-ghost btn-sm" id="print-card">Export PDF</button></div>
      <div class="fits" id="card-stats"><span><span class="small">Views, 30 days</span><b>${st.views30d || 0}</b></span><span><span class="small">Video plays, 30 days</span><b>${st.videoPlays30d || 0}</b></span><span><span class="small">From coach emails</span><b>${st.tokenViews || 0}</b></span><span><span class="small">Last viewed</span><b>${st.lastViewAt ? fmtDate(st.lastViewAt.toDate ? st.lastViewAt.toDate() : st.lastViewAt) : '—'}</b></span></div>
      ${(st.recentVideoViews || []).some((r) => r.schoolName) ? `<p class="small" id="video-views">Film watched by ${st.recentVideoViews.filter((r) => r.schoolName).slice(0, 4).map((r) => `<b>${esc(r.schoolName)}</b> (${esc(r.title)})`).join(' · ')}</p>` : ''}
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
