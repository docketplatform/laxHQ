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
const monthLabel = (ym) => (ym ? new Date(`${ym}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '');
const heightLabel = (i) => (i ? `${Math.floor(i / 12)}′${i % 12}″` : null);
const HAND = { R: 'Right', L: 'Left', B: 'Both' };
const SPORT = { mlax: 'Boys’ lacrosse', wlax: 'Girls’ lacrosse' };
const initials = (c) => `${(c.firstName || '?')[0]}${(c.lastName || c.lastInitial || '')[0] || ''}`.toUpperCase();
const positionsOf = (c) => [c.position, ...(c.otherPositions || [])].filter(Boolean).map((p) => positionLabel(c.sport, p));

function jerseySvg(num) {
  return `<svg class="rjsvg" viewBox="0 0 64 64" aria-hidden="true"><path d="M20 6l-14 8 5 13 6-3v34h30V24l6 3 5-13-14-8c-2 5-6 8-12 8s-10-3-12-8z" fill="var(--ink)"/>
    <text x="32" y="46" text-anchor="middle" font-size="20" font-weight="700" fill="#fff" font-family="var(--display), system-ui">${esc(num || '')}</text></svg>`;
}

/** The main player (click to load, so nothing plays or tracks until someone presses play). */
function playerFace(v, e) {
  const label = esc(v.title || kindLabel(v.kind));
  if (!e.embedUrl) {
    return `<a class="rfilm" href="${esc(e.watchUrl)}" target="_blank" rel="noopener" data-play-link><span class="play" aria-hidden="true"></span><span>Watch ${label} on ${esc(PROVIDER_LABEL[e.provider])} ↗</span></a>`;
  }
  return `<button class="rfilm rface" data-play ${e.thumb ? `style="background-image:linear-gradient(rgba(14,27,44,.25),rgba(14,27,44,.6)),url('${esc(e.thumb)}')"` : ''}>
    <span class="play" aria-hidden="true"></span><span>Play ${label}</span></button>`;
}

function filmHtml(c) {
  const list = cardVideosOf(c);
  if (!list.length) return '';
  const e0 = videoEmbed(list[0].url);
  return `<section class="rsec" id="r-film" data-tab="Film"><h2>Film</h2>
    <div class="rplayer" id="rplayer" data-v="0">${playerFace(list[0], e0)}</div>
    <div class="rvideos" aria-label="Videos">${list.map((v, i) => {
    const e = videoEmbed(v.url);
    return `<button class="rvid${i === 0 ? ' on' : ''}" data-v="${i}" aria-label="Play ${esc(v.title || kindLabel(v.kind))}">
      <span class="rthumb"${e.thumb ? ` style="background-image:url('${esc(e.thumb)}')"` : ''}><span class="rvid-play" aria-hidden="true"></span></span>
      <span class="rvid-text"><b>${esc(v.title || kindLabel(v.kind))}</b>
      <span>${esc([kindLabel(v.kind), monthLabel(v.date), PROVIDER_LABEL[e.provider]].filter(Boolean).join(' · '))}<span data-views-for="${i}"></span></span></span></button>`;
  }).join('')}</div>
    <div class="print-only">${list.map((v) => `<p><b>${esc(v.title || kindLabel(v.kind))}:</b> ${esc(v.url)}</p>`).join('')}</div>
  </section>`;
}

/**
 * Wire up the card's videos. onPlay(index) is called once per video when it starts
 * (the public page uses it to count plays).
 */
export function bindVideos(c, onPlay) {
  const list = cardVideosOf(c);
  const box = $('rplayer');
  if (!box || !list.length) return;
  const played = new Set();
  const mark = (i) => { if (!played.has(i)) { played.add(i); onPlay?.(i); } };
  const start = (i, autoplay) => {
    const v = list[i]; const e = videoEmbed(v.url);
    box.dataset.v = String(i);
    document.querySelectorAll('.rvid').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === i));
    if (!autoplay || !e.embedUrl) { box.innerHTML = playerFace(v, e); bindFace(); return; }
    mark(i);
    const auto = e.provider === 'youtube' || e.provider === 'vimeo' ? `${e.embedUrl.includes('?') ? '&' : '?'}autoplay=1` : '';
    box.innerHTML = `<iframe src="${esc(e.embedUrl + auto)}" title="${esc(v.title || kindLabel(v.kind))}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  };
  const bindFace = () => {
    box.querySelector('[data-play]')?.addEventListener('click', () => start(Number(box.dataset.v), true));
    box.querySelector('[data-play-link]')?.addEventListener('click', () => mark(Number(box.dataset.v)));
  };
  bindFace();
  document.querySelectorAll('.rvid').forEach((b) => b.addEventListener('click', () => {
    const i = Number(b.dataset.v); const e = videoEmbed(list[i].url);
    if (e.embedUrl) { start(i, true); box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } else { start(i, false); window.open(e.watchUrl, '_blank', 'noopener'); mark(i); }
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
  const up = (c.events || []).filter((e) => (e.end || e.start) >= today).slice(0, 8);
  if (!up.length) return '';
  return `<section class="rsec" id="r-events" data-tab="Events"><h2>Where to see ${esc(c.firstName)}</h2>
    <div class="revents">${up.map((e) => `<div class="revent">
      <span class="rdate">${esc(dayRange(e.start, e.end))}</span>
      <span><b>${esc(e.title)}</b>${e.city ? `<br><span class="rmuted">${esc(e.city)}${e.state ? `, ${esc(e.state)}` : ''}</span>` : ''}</span></div>`).join('')}</div>
  </section>`;
}

function aboutHtml(c) {
  const social = c.social || {};
  if (!c.statement && !(c.honors || []).length && !(c.badges || []).length && !social.x && !social.instagram) return '';
  const long = (c.statement || '').length > 420;
  return `<section class="rsec" id="r-about" data-tab="About"><h2>About</h2>
    ${c.statement ? `<div class="rstatement${long ? ' clamp' : ''}" id="rstatement">${esc(c.statement).replace(/\n/g, '<br>')}</div>
      ${long ? '<button class="rlink" id="rmore">Show more</button>' : ''}` : ''}
    ${(c.badges || []).length ? `<div class="rbadges">${c.badges.map((b) => `<span class="rbadge">${esc(b)}</span>`).join('')}</div>` : ''}
    ${(c.honors || []).length ? `<h3>Honors</h3><ul class="rhonors">${c.honors.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
    ${social.x || social.instagram ? `<div class="rsocial">${social.x ? `<a href="https://x.com/${esc(social.x)}" target="_blank" rel="noopener">X @${esc(social.x)}</a>` : ''}${social.instagram ? `<a href="https://instagram.com/${esc(social.instagram)}" target="_blank" rel="noopener">Instagram @${esc(social.instagram)}</a>` : ''}</div>` : ''}
  </section>`;
}

function athleticHtml(c) {
  const keys = [...(STATS_BY_POSITION[c.position] || []), ...Object.keys(c.stats || {})]
    .filter((k, i, a) => a.indexOf(k) === i && c.stats?.[k] != null).slice(0, 6);
  const teams = [
    c.club ? { name: `${c.club.name}${c.club.team ? ` ${c.club.team}` : ''}`, sub: ['Club', c.club.level ? `${c.club.level[0].toUpperCase()}${c.club.level.slice(1)} level` : null].filter(Boolean).join(' · '), jersey: c.club.jersey || c.jersey } : null,
    c.highSchool ? { name: c.highSchool.name, sub: ['High school', c.highSchool.state].filter(Boolean).join(' · '), jersey: c.highSchool.jersey } : null,
  ].filter(Boolean);
  const facts = [
    ['Position', positionsOf(c).join(', ')], ['Height', heightLabel(c.heightIn)], ['Dominant hand', HAND[c.hand]],
  ].filter(([, v]) => v);
  return `<section class="rsec" id="r-athletic" data-tab="Athletic"><h2>Athletic</h2>
    ${teams.length ? `<h3>Teams</h3><div class="rteams">${teams.map((t) => `<div class="rteam">${t.jersey ? jerseySvg(t.jersey) : ''}<span><b>${esc(t.name)}</b><br><span class="rmuted">${esc(t.sub)}</span></span></div>`).join('')}</div>` : ''}
    ${keys.length ? `<h3>Stats${c.statsSeason ? ` · ${esc(c.statsSeason)}` : ''}</h3><div class="rstats">${keys.map((k) => `<div class="cs"><b>${esc(c.stats[k])}${k.endsWith('Pct') ? '%' : ''}</b><span>${esc(STAT_LABELS[k] || k)}</span></div>`).join('')}</div>` : ''}
    <dl class="rfacts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
      ${(c.rankings || []).map((r) => `<div><dt>${esc(r.source)}</dt><dd>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.value)}</a>` : esc(r.value)} <span class="rself">self-reported</span></dd></div>`).join('')}</dl>
  </section>`;
}

function academicHtml(c) {
  const rows = [['Class of', c.gradYear]];
  if (c.gpa != null) rows.push([`GPA${c.gpaWeighted === true ? ' (weighted)' : c.gpaWeighted === false ? ' (unweighted)' : ''}`, `${c.gpa}${c.gpaScale === 5 ? ' / 5.0' : ' / 4.0'}`]);
  if (c.tests?.sat) rows.push(['SAT', `${c.tests.sat} / 1600`]);
  if (c.tests?.act) rows.push(['ACT', `${c.tests.act} / 36`]);
  return `<section class="rsec" id="r-academic" data-tab="Academic"><h2>Academic</h2>
    <div class="rstats">${rows.map(([k, v]) => `<div class="cs"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>
  </section>`;
}

/** The card itself (public page). */
export function cardHtml(c) {
  const keyFacts = [
    ['Grad year', c.gradYear], ['Hometown', c.hometown ? `${c.hometown.city}${c.hometown.state ? `, ${c.hometown.state}` : ''}` : null],
    ['Club', c.club ? `${c.club.name}${c.club.team ? ` ${c.club.team}` : ''}` : null], ['Height', heightLabel(c.heightIn)],
    ['GPA', c.gpa != null ? String(c.gpa) : null],
  ].filter(([, v]) => v);
  const sections = [filmHtml(c), aboutHtml(c), athleticHtml(c), academicHtml(c), eventsHtml(c)].filter(Boolean);
  const tabs = sections.map((s) => [/id="(r-[a-z]+)"/.exec(s)[1], /data-tab="([^"]+)"/.exec(s)[1]]);
  const mail = c.contactEmail ? `mailto:${esc(c.contactEmail)}?subject=${encodeURIComponent(`${cardTitle(c)} · Class of ${c.gradYear}`)}` : null;
  return `<article class="rcard" aria-label="Recruiting card">
    <header class="rhero">
      <div class="rhero-top">
        <span class="ravatar" aria-hidden="true">${esc(initials(c))}</span>
        <div class="rid"><h1 class="rname">${esc(cardTitle(c))}</h1>
          <p class="rmeta">${esc(positionsOf(c).join(', '))} · Class of ${esc(c.gradYear)}${SPORT[c.sport] ? ` · ${esc(SPORT[c.sport])}` : ''}</p></div>
        ${c.jersey ? `<span class="rjersey">#${esc(c.jersey)}</span>` : ''}
      </div>
      ${keyFacts.length ? `<dl class="rkeys">${keyFacts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      <div class="ractions">${mail ? `<a class="btn btn-primary" href="${mail}">Contact the family</a>` : ''}<button class="btn rshare" id="rshare" type="button">Share</button></div>
    </header>
    ${tabs.length > 1 ? `<nav class="rtabs" aria-label="Sections">${tabs.map(([id, label]) => `<button type="button" data-jump="${id}">${esc(label)}</button>`).join('')}</nav>` : ''}
    ${sections.join('')}
  </article>`;
}

/** Share button, section tabs and "Show more" on the public card. */
function bindCardChrome(card, slug) {
  $('rshare')?.addEventListener('click', async () => {
    const url = `${location.origin}/c/${slug}`; // never pass on the coach's tracked token
    const title = `${cardTitle(card)} · Class of ${card.gradYear}`;
    try {
      if (navigator.share) { await navigator.share({ title, url }); return; }
      await navigator.clipboard.writeText(url);
      $('rshare').textContent = 'Link copied';
    } catch { /* cancelled */ }
  });
  document.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => $(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
  $('rmore')?.addEventListener('click', () => { $('rstatement').classList.remove('clamp'); $('rmore').remove(); });
}

/** Public play counts per video (cardCounts/{slug}), filled in after the card shows. */
function loadVideoCounts(card, slug) {
  getDoc(doc(db, `cardCounts/${slug}`)).then((s) => {
    const counts = s.data()?.videos || {};
    cardVideosOf(card).forEach((v, i) => {
      const n = counts[v.url];
      const el = document.querySelector(`[data-views-for="${i}"]`);
      if (el && n) el.textContent = ` · ${n} view${n === 1 ? '' : 's'}`;
    });
  }).catch(() => {});
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
  bindCardChrome(card, slug);
  loadVideoCounts(card, slug);
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
