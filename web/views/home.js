// Home: countdown, readiness and this week's steps for the current player.
import { esc, fmtDate } from '../util.js';
import { buildPlan, gradeLabel, afterSophomoreDate, daysBetween, startOfDay } from '../lib/plan.js';
import { positionLabel } from '../lib/options.js';
import { sampleViews } from './sample.js';
import { checklistItemHtml, bindChecklist } from './plan.js';
import { getDraft } from './onboarding.js';
import { doc, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function playerSwitcher(ctx) {
  const { players } = ctx.state;
  if (players.length < 2) return '';
  const cur = ctx.currentPlayer();
  return `<div class="seg" role="tablist" aria-label="Players">${players.map((p) => `<button role="tab" aria-selected="${p.id === cur.id}" data-player="${p.id}">${esc(p.firstName)}</button>`).join('')}</div>`;
}
export function bindSwitcher(ctx) {
  document.querySelectorAll('[data-player]').forEach((b) => b.addEventListener('click', () => ctx.selectPlayer(b.dataset.player)));
}

const ALERT_LINK = { followup_due: (a) => `#/coaches/${a.refs?.contactId}`, overlap: () => '#/events', sync_failed: () => '#/events' };

function alertsHtml(ctx) {
  const list = [...(ctx.state.alerts || [])].sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)).slice(0, 5);
  if (!list.length) return '';
  return `<section class="card" id="alerts"><h2>Needs attention</h2><div class="list">${list.map((a) => `<div>
    <span class="dot ${a.severity === 'warn' ? 'warn' : ''}" aria-hidden="true"></span>
    <a class="grow" href="${esc((ALERT_LINK[a.type] || (() => '#/home'))(a))}">${esc(a.title)}</a>
    <button class="link" data-dismiss="${esc(a.id)}" aria-label="Dismiss: ${esc(a.title)}">Dismiss</button></div>`).join('')}</div></section>`;
}

export default {
  render(ctx) {
    const p = ctx.currentPlayer();
    if (!ctx.isPro() || !p) {
      if (ctx.isPro()) {
        return `<h1>Welcome to LaxHQ Pro</h1>
          <div class="card"><h2>Set up your player</h2><p class="muted">Grad year, position, school and club. Your countdown and plan build from it.</p>
          <a class="btn btn-primary" href="#/onboarding">${getDraft() ? 'Finish setting up' : 'Set up my player'}</a></div>`;
      }
      return sampleViews.home();
    }
    if (!ctx.state.template || !ctx.state.checklist) return '<p class="muted" role="status">Loading your plan…</p>';
    const plan = buildPlan(ctx.state.template, p, ctx.state.checklist);
    const me = ctx.state.family?.members?.[ctx.state.user.uid]?.name?.split(' ')[0];
    const d1 = plan.daysToContact;
    const d2 = (p.openDivisions || []).includes('D2') ? daysBetween(startOfDay(new Date()), afterSophomoreDate(p.gradYear)) : null;
    return `${playerSwitcher(ctx)}
      <div><p class="small">${greeting()}${me ? `, ${esc(me)}` : ''}</p>
        <h1>${esc(p.firstName)} · Class of ${p.gradYear}</h1>
        <p class="small">${esc(gradeLabel(plan.grade))} · ${esc(positionLabel(p.sport, p.position))}${p.club?.name ? ` · ${esc(p.club.name)}` : ''}</p></div>
      <div class="card dark" id="countdown">
        <span class="small caps">D1 coach contact opens</span>
        ${d1 > 0
    ? `<div class="row start baseline"><span class="big">${d1}</span><b>day${d1 === 1 ? '' : 's'} · ${fmtDate(plan.contactOpens, { month: 'short', day: 'numeric', year: 'numeric' })}</b></div>`
    : `<div class="row start baseline"><span class="big">Open</span><b>since ${fmtDate(plan.contactOpens, { month: 'short', day: 'numeric', year: 'numeric' })}</b></div>`}
        <div class="bar" role="img" aria-label="Readiness ${plan.readiness}%"><i style="width:${plan.readiness}%"></i></div>
        <span class="small">Readiness ${plan.readiness}% · ${plan.doneCount} of ${plan.dueSoFar} steps done so far</span>
        ${d2 !== null ? `<span class="small">D2 contact ${d2 > 0 ? `opens in ${d2} days (June 15 after sophomore year)` : 'is open'}.</span>` : ''}
      </div>
      ${alertsHtml(ctx)}
      <div class="card"><div class="row"><h2>This week</h2><a href="#/plan">Full plan</a></div>
        ${plan.thisWeek.length ? `<div class="list">${plan.thisWeek.map((i) => checklistItemHtml(i, ctx)).join('')}</div>`
    : '<p class="muted">Nothing due right now. Look ahead in the full plan.</p>'}
      </div>`;
  },
  bind(ctx) {
    bindSwitcher(ctx); bindChecklist(ctx);
    document.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => {
      updateDoc(doc(ctx.db, `families/${ctx.state.claims.fid}/players/${ctx.currentPlayer().id}/alerts/${b.dataset.dismiss}`), { dismissedAt: serverTimestamp() }).catch(console.error);
    }));
  },
};
