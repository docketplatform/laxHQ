// Events tab: summer plan (#/events), add/edit an event (#/events/add, #/events/<id>),
// and the club schedule connection (#/events/club).
import {
  doc, collection, addDoc, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { $, esc, options, formToObject, fmtDay, errorText, money } from '../util.js';
import { STATES } from '../lib/options.js';
import { totals } from '../lib/expenses.js';
import { sampleViews } from './sample.js';
import { playerSwitcher, bindSwitcher } from './home.js';

const KINDS = [
  { value: 'showcase', label: 'Showcase' }, { value: 'tournament', label: 'Tournament' },
  { value: 'camp', label: 'College camp' }, { value: 'prospect_day', label: 'Prospect day' }, { value: 'other', label: 'Other' },
];
const STATUSES = [
  { value: 'considering', label: 'Considering' }, { value: 'registered', label: 'Registered' },
  { value: 'attended', label: 'Attended' }, { value: 'skipped', label: 'Skipped' },
];
const todayIso = () => new Date().toISOString().slice(0, 10);
const day = (iso) => fmtDay(new Date(`${iso}T12:00:00`));
const range = (a, b) => (b && b !== a ? `${day(a)} – ${day(b)}` : day(a));

// ---------- live data ----------
let key = null; const unsubs = [];
function watch(ctx) {
  const p = ctx.currentPlayer();
  const k = `${ctx.state.claims.fid}/${p.id}/${(p.teamIds || []).join(',')}`;
  if (k === key) return;
  stopEventsWatch();
  key = k;
  const s = ctx.state;
  s.plan = null; s.teams = {}; s.teamEvents = {}; s.expenses = s.expenses || null;
  unsubs.push(onSnapshot(collection(ctx.db, `families/${s.claims.fid}/players/${p.id}/plan`), (snap) => {
    s.plan = snap.docs.map((d) => ({ id: d.id, ...d.data() })); ctx.rerender();
  }, (e) => console.error('plan', e)));
  unsubs.push(onSnapshot(collection(ctx.db, `families/${s.claims.fid}/expenses`), (snap) => {
    s.expenses = snap.docs.map((d) => ({ id: d.id, ...d.data() })); ctx.rerender();
  }, (e) => console.error('expenses', e)));
  for (const tid of p.teamIds || []) {
    unsubs.push(onSnapshot(doc(ctx.db, `teams/${tid}`), (d) => { s.teams[tid] = d.exists() ? { id: tid, ...d.data() } : null; ctx.rerender(); }, (e) => console.error('team', e)));
    unsubs.push(onSnapshot(query(collection(ctx.db, `teams/${tid}/events`), where('endDate', '>=', todayIso())), (snap) => {
      s.teamEvents[tid] = snap.docs.map((d) => ({ id: d.id, teamId: tid, ...d.data() })); ctx.rerender();
    }, (e) => console.error('team events', e)));
  }
}
export function stopEventsWatch() { while (unsubs.length) unsubs.pop()(); key = null; }

function conflictsFor(ctx, planId) {
  const a = (ctx.state.alerts || []).find((x) => x.type === 'overlap' && x.refs?.planEventId === planId);
  return a ? a.title : null;
}
const ago = (ts) => {
  if (!ts?.toDate) return 'never';
  const h = Math.round((Date.now() - ts.toDate()) / 36e5);
  return h < 1 ? 'just now' : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

// ---------- main view ----------
function mainView(ctx) {
  const s = ctx.state; const p = ctx.currentPlayer();
  if (!s.plan) return '<p class="muted" role="status">Loading…</p>';
  const plan = [...s.plan].sort((a, b) => a.start.localeCompare(b.start));
  const upcoming = plan.filter((e) => (e.end || e.start) >= todayIso() && e.status !== 'skipped');
  const teamEvents = Object.values(s.teamEvents).flat().filter((e) => !e.cancelled);
  const teams = (p.teamIds || []).map((t) => s.teams[t]).filter(Boolean);
  const t = s.expenses ? totals(s.expenses.filter((e) => e.source === 'plan' && (e.playerIds || []).includes(p.id)), { season: null }) : null;
  const msg = s.ui.eventsMsg;

  // Merged calendar for the next 60 days.
  const horizon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const items = [
    ...upcoming.filter((e) => e.start <= horizon).map((e) => ({ date: e.start, end: e.end, title: e.title, kind: 'plan', id: e.id, conflict: conflictsFor(ctx, e.id) })),
    ...teamEvents.filter((e) => e.startDate <= horizon).map((e) => ({ date: e.startDate, end: e.endDate, title: e.title, kind: 'club', team: s.teams[e.teamId]?.name, time: e.allDay ? null : new Date(e.start) })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  return `${playerSwitcher(ctx)}
    <div class="row"><h1>Summer plan</h1><a class="btn btn-primary btn-sm" href="#/events/add">Add event</a></div>
    ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
    <div class="card dark tri"><div><b>${upcoming.length}</b><span>Events</span></div>
      <div><b>${upcoming.filter((e) => conflictsFor(ctx, e.id)).length}</b><span>Conflicts</span></div>
      <div><b>${t ? money(t.plannedCents) : '—'}</b><span>Planned cost</span></div></div>
    ${plan.map((e) => {
    const conflict = conflictsFor(ctx, e.id);
    return `<a class="card link-card${e.status === 'skipped' ? ' faded' : ''}" href="#/events/${esc(e.id)}"><div class="row start">
      <span class="datebox"><span>${esc(new Date(`${e.start}T12:00:00`).toLocaleDateString('en-US', { month: 'short' }).toUpperCase())}</span><b>${Number(e.start.slice(8, 10))}</b></span>
      <span class="grow"><b>${esc(e.title)}</b><br><span class="small">${esc([e.location?.city, e.location?.state].filter(Boolean).join(', '))}${e.nights ? ` · ${e.nights} night${e.nights > 1 ? 's' : ''}` : ''} · ${esc(STATUSES.find((x) => x.value === e.status)?.label || '')}${e.status === 'attended' && e.actualCost != null ? ` · ${money(e.actualCost * 100)}` : e.costEstimate ? ` · ~${money(e.costEstimate * 100)}` : ''}</span></span></div>
      ${conflict ? `<p class="conflict" role="note">${esc(conflict)}</p>` : ''}</a>`;
  }).join('')}
    ${!plan.length ? '<div class="card"><h2>Plan your summer</h2><p class="muted">Add the showcases, tournaments and college camps you’re considering. LaxHQ checks them against your club schedule and tracks what they’ll cost.</p></div>' : ''}

    <section class="card" id="club">
      <div class="row"><h2>Club schedule</h2><a class="btn btn-ghost btn-sm" href="#/events/club">${teams.length ? 'Add another' : 'Connect'}</a></div>
      ${teams.length ? teams.map((tm) => `<div class="row"><span><b>${esc(tm.name)}</b><br><span class="small">${tm.syncStatus === 'error'
    ? `<span class="err">Stopped syncing: ${esc(tm.syncError || '')}</span>` : `${tm.eventCount || 0} events · synced ${ago(tm.lastSyncAt)}`}</span></span>
        <button class="link" data-disconnect="${esc(tm.id)}">Disconnect</button></div>`).join('')
    : '<p class="muted">Connect your club team’s calendar link (TeamSnap, SportsEngine, LeagueApps or Google Calendar) and LaxHQ flags every clash with your summer plan.</p>'}
      ${teams.length ? '<p class="small">Team apps update their feeds on their own schedule; changes can take a few hours to show here.</p>' : ''}
    </section>

    ${items.length ? `<section class="card"><h2>Next 60 days</h2><div class="list">${items.map((i) => `<div>
      <span class="small" style="min-width:56px">${day(i.date)}</span>
      <span class="grow"><b>${esc(i.title)}</b><br><span class="small">${i.kind === 'club' ? `${esc(i.team || 'Club')}${i.time ? ` · ${i.time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}` : 'Summer plan'}</span></span>
      ${i.conflict ? '<span class="chip c-reach">Clash</span>' : i.kind === 'club' ? '<span class="chip c-muted">Club</span>' : '<span class="chip c-target">Plan</span>'}</div>`).join('')}</div></section>` : ''}

    <a class="card link-card" href="#/spend"><div class="row"><span><b>Recruiting spend</b><br><span class="small">Club dues, events, travel, highlight reels and more, all in one total</span></span><span aria-hidden="true">→</span></div></a>`;
}

// ---------- add / edit an event ----------
function eventForm(ctx, ev = {}) {
  const loc = ev.location || {};
  const msg = ctx.state.ui.eventMsg;
  return `<a class="back" href="#/events">← Summer plan</a><h1>${ev.id ? 'Edit event' : 'Add an event'}</h1>
    ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
    <form id="event-form" class="card" novalidate data-keep>
      <div class="field"><label for="ev-title">Event</label><input id="ev-title" name="title" maxlength="120" value="${esc(ev.title)}" placeholder="Mid-Atlantic Summer Showcase" required></div>
      <div class="two">
        <div class="field"><label for="ev-kind">Type</label><select id="ev-kind" name="kind">${options(KINDS, ev.kind || 'showcase')}</select></div>
        <div class="field"><label for="ev-status">Status</label><select id="ev-status" name="status">${options(STATUSES, ev.status || 'considering')}</select></div>
      </div>
      <div class="two">
        <div class="field"><label for="ev-start">Starts</label><input id="ev-start" name="start" type="date" value="${esc(ev.start)}" required></div>
        <div class="field"><label for="ev-end">Ends</label><input id="ev-end" name="end" type="date" value="${esc(ev.end)}"></div>
      </div>
      <div class="two">
        <div class="field"><label for="ev-city">City</label><input id="ev-city" name="location.city" maxlength="60" value="${esc(loc.city)}"></div>
        <div class="field"><label for="ev-state">State</label><select id="ev-state" name="location.state">${options(STATES, loc.state, { blank: 'Choose' })}</select></div>
      </div>
      <div class="two">
        <div class="field"><label for="ev-cost">Estimated cost ($)</label><input id="ev-cost" name="costEstimate" inputmode="decimal" value="${esc(ev.costEstimate)}" placeholder="Registration + travel + hotel"></div>
        <div class="field"><label for="ev-nights">Nights away</label><input id="ev-nights" name="nights" inputmode="numeric" value="${esc(ev.nights)}"></div>
      </div>
      <div class="field" ${ev.status === 'attended' ? '' : 'hidden'} id="actual-wrap"><label for="ev-actual">What it actually cost ($)</label><input id="ev-actual" name="actualCost" inputmode="decimal" value="${esc(ev.actualCost)}"></div>
      <p class="small">The estimated cost shows as a planned expense in Recruiting spend. Mark the event Attended and enter what it cost to move it to spent.</p>
      <button class="btn btn-primary" type="submit">${ev.id ? 'Save' : 'Add to plan'}</button>
    </form>
    ${ev.id ? '<button class="btn btn-ghost" id="delete-event">Delete event</button>' : ''}`;
}

const num = (v) => (v == null || v === '' ? null : Number(String(v).replace(/[$,\s]/g, '')));

// ---------- club connection ----------
function clubView(ctx) {
  const ui = ctx.state.ui;
  const step = ui.club;
  const msg = ui.clubMsg;
  return `<a class="back" href="#/events">← Summer plan</a><h1>Connect your club schedule</h1>
    ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
    ${!step ? `<form id="club-form" class="card" novalidate>
      <div class="field"><label for="club-url">Calendar link</label><input id="club-url" name="url" type="url" placeholder="webcal://… or https://…" autocomplete="off"></div>
      <button class="btn btn-primary" type="submit">${ui.clubBusy ? 'Reading the calendar…' : 'Connect'}</button>
    </form>
    <section class="card"><h2>Where to find the link</h2>
      <ul class="howto">
        <li><b>TeamSnap:</b> open your team, then Schedule → the calendar sync or export option. Copy the link.</li>
        <li><b>SportsEngine:</b> on the team page’s schedule, use Subscribe and copy the iCal link.</li>
        <li><b>LeagueApps:</b> in your schedule, choose Sync to calendar and copy the link.</li>
        <li><b>Google Calendar:</b> Settings → the calendar → “Secret address in iCal format”.</li>
      </ul>
      <p class="small">Menu names change from time to time; look for “sync”, “subscribe”, “export” or “iCal”. The link stays private: LaxHQ never shows it to anyone, including other families on your team.</p>
    </section>`
    : `<section class="card"><h2>Which calendars are lacrosse?</h2>
      <p class="small">We found ${step.calendars.length} calendar${step.calendars.length > 1 ? 's' : ''} in that link. Pick the club team; everything else is ignored and never saved.</p>
      <form id="cal-form" class="stack">${step.calendars.map((c, i) => `<label class="check"><input type="checkbox" name="cal" value="${esc(c.name)}"${step.calendars.length === 1 || i === 0 ? ' checked' : ''}> ${esc(c.name)} <span class="small">(${c.count} events)</span></label>`).join('')}
      <button class="btn btn-primary" type="submit">${ui.clubBusy ? 'Connecting…' : 'Connect these'}</button></form></section>`}`;
}

// ---------- screen ----------
export default {
  tab: 'events',
  render(ctx, args) {
    if (!ctx.isPro() || !ctx.currentPlayer()) return sampleViews.events();
    watch(ctx);
    if (args[0] === 'add') return eventForm(ctx, ctx.state.ui.copyFrom || {});
    if (args[0] === 'club') return clubView(ctx);
    if (args[0]) {
      const ev = (ctx.state.plan || []).find((e) => e.id === decodeURIComponent(args[0]));
      if (!ctx.state.plan) return '<p class="muted" role="status">Loading…</p>';
      return ev ? eventForm(ctx, ev) : '<a class="back" href="#/events">← Summer plan</a><p class="muted">That event was not found.</p>';
    }
    return mainView(ctx);
  },
  bind(ctx, args) {
    bindSwitcher(ctx);
    const p = ctx.currentPlayer();
    if (!ctx.isPro() || !p) return; // sample view: nothing to bind
    const planPath = `families/${ctx.state.claims.fid}/players/${p.id}/plan`;
    $('ev-status')?.addEventListener('change', (e) => { $('actual-wrap').hidden = e.target.value !== 'attended'; });
    $('event-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formToObject(e.target);
      if (!d.title) { ctx.setUi('eventMsg', { text: 'Enter the event name.', bad: true }); return; }
      if (!d.start) { ctx.setUi('eventMsg', { text: 'Choose the start date.', bad: true }); return; }
      if (d.end && d.end < d.start) { ctx.setUi('eventMsg', { text: 'The end date is before the start date.', bad: true }); return; }
      const cost = num(d.costEstimate); const actual = num(d.actualCost); const nights = num(d.nights);
      if ([cost, actual, nights].some((v) => v !== null && (!Number.isFinite(v) || v < 0))) { ctx.setUi('eventMsg', { text: 'Costs and nights must be numbers.', bad: true }); return; }
      const data = {
        title: d.title.slice(0, 120), kind: d.kind, status: d.status, start: d.start, end: d.end || d.start,
        location: { city: d.location?.city || null, state: d.location?.state || null },
        costEstimate: cost, nights: nights === null ? null : Math.round(nights), actualCost: d.status === 'attended' ? actual : null,
        source: 'manual', updatedAt: serverTimestamp(),
      };
      try {
        if (args[0] && args[0] !== 'add') await updateDoc(doc(ctx.db, `${planPath}/${decodeURIComponent(args[0])}`), data);
        else await addDoc(collection(ctx.db, planPath), { ...data, createdAt: serverTimestamp() });
        e.target.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
        ctx.navigate('#/events', { eventsMsg: { text: 'Saved. LaxHQ is checking it against your club schedule.' } });
      } catch (err) { ctx.setUi('eventMsg', { text: errorText(err), bad: true }); }
    });
    $('delete-event')?.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      try { await deleteDoc(doc(ctx.db, `${planPath}/${decodeURIComponent(args[0])}`)); ctx.navigate('#/events'); } catch (err) { ctx.setUi('eventMsg', { text: errorText(err), bad: true }); }
    });
    document.querySelectorAll('[data-disconnect]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Stop syncing this club calendar?')) return;
      try { await ctx.call('disconnectTeam', { playerId: p.id, teamId: b.dataset.disconnect }); ctx.setUi('eventsMsg', { text: 'Disconnected.' }); } catch (err) { ctx.setUi('eventsMsg', { text: errorText(err), bad: true }); }
    }));
    $('club-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('club-url').value.trim();
      if (!url) { ctx.setUi('clubMsg', { text: 'Paste the calendar link.', bad: true }); return; }
      ctx.state.ui.clubBusy = true; ctx.setUi('clubMsg', null);
      try {
        const res = await ctx.call('connectSchedule', { playerId: p.id, url });
        ctx.state.ui.clubBusy = false;
        ctx.setUi('club', res);
      } catch (err) { ctx.state.ui.clubBusy = false; ctx.setUi('clubMsg', { text: errorText(err), bad: true }); }
    });
    $('cal-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const calendars = [...e.target.querySelectorAll('input[name=cal]:checked')].map((i) => i.value);
      if (!calendars.length) { ctx.setUi('clubMsg', { text: 'Pick at least one calendar.', bad: true }); return; }
      ctx.state.ui.clubBusy = true; ctx.setUi('clubMsg', null);
      try {
        const r = await ctx.call('selectCalendars', { feedId: ctx.state.ui.club.feedId, calendars });
        ctx.navigate('#/events', { eventsMsg: { text: r.joined ? `Connected. ${r.teamName} was already on LaxHQ, so you’re sharing one sync with your teammates.` : `Connected ${r.teamName}: ${r.eventCount} events.` } });
      } catch (err) { ctx.state.ui.clubBusy = false; ctx.setUi('clubMsg', { text: errorText(err), bad: true }); }
    });
  },
};
