// The sample family free accounts browse. Static data, nothing saved.
import { esc } from '../util.js';
import { daysBetween, startOfDay, contactOpensDate } from '../lib/plan.js';

export const SAMPLE = {
  family: 'Morrison family', player: 'Jake', gradYear: 2029,
  readiness: 38, stepsDone: 11, stepsTotal: 29,
  stats: { schools: 14, coaches: 9, events: 3 },
  week: [
    { t: 'Cut fall-ball highlight reel', d: '3 games tagged · aim for 3–4 min', done: false },
    { t: 'Send intro email · 2 D3 schools', d: 'Athletes may reach out any time', done: false },
    { t: 'Upload fall transcript', d: 'GPA 3.7 · unlocks academic fit', done: true },
  ],
  schools: [
    { n: 'Johns Hopkins', m: 'D1 · Big Ten · Baltimore, MD', tier: 'Reach' },
    { n: 'Lafayette', m: 'D1 · Patriot League · Easton, PA', tier: 'Target' },
    { n: 'Tufts', m: 'D3 · NESCAC · Medford, MA', tier: 'Target' },
    { n: 'Stevens Institute', m: 'D3 · MAC · Hoboken, NJ', tier: 'Likely' },
  ],
  coaches: [
    { n: 'Tufts', m: 'Recruiting coordinator · replied 2 days ago', s: 'Replied', c: 'c-likely' },
    { n: 'Lafayette', m: 'Head coach · sent 18 days ago', s: 'Follow up', c: 'c-reach' },
    { n: 'Stevens Institute', m: 'Assistant coach · sent 6 days ago', s: 'Emailed', c: 'c-target' },
  ],
  events: [
    { d: 'Jun 19', n: 'Mid-Atlantic Summer Showcase', m: 'Bel Air, MD · 2 nights · ~$1,150' },
    { d: 'Jul 10', n: 'Academic D3 Invitational', m: 'Tarrytown, NY · day trip · ~$290' },
    { d: 'Jul 24', n: 'Northeast Elite Weekend', m: 'Newport, RI · 3 nights · ~$1,400' },
  ],
};

export function sampleBanner() {
  return `<div class="banner" role="note"><span><b>You’re looking at a sample family.</b>Start Pro to enter and save your own player’s plan.</span><a class="btn btn-primary btn-sm" href="#/onboarding">Set up my player</a></div>`;
}

export const sampleViews = {
  home() {
    const days = Math.max(daysBetween(startOfDay(new Date()), contactOpensDate(SAMPLE.gradYear)), 0);
    return `${sampleBanner()}
      <div><p class="small">Good morning, ${esc(SAMPLE.family)}</p><h1>${esc(SAMPLE.player)} · Class of ${SAMPLE.gradYear}</h1></div>
      <div class="card dark">
        <span class="small caps">D1 coach contact opens</span>
        <div class="row start baseline"><span class="big">${days}</span><b>days · Sept 1, ${SAMPLE.gradYear - 2}</b></div>
        <div class="bar" role="img" aria-label="Readiness ${SAMPLE.readiness}%"><i style="width:${SAMPLE.readiness}%"></i></div>
        <span class="small">Readiness ${SAMPLE.readiness}% · ${SAMPLE.stepsDone} of ${SAMPLE.stepsTotal} steps done</span>
      </div>
      <div class="card"><div class="row" style="text-align:center">
        <div><b class="stat">${SAMPLE.stats.schools}</b><p class="small">Target schools</p></div>
        <div><b class="stat">${SAMPLE.stats.coaches}</b><p class="small">Coaches emailed</p></div>
        <div><b class="stat">${SAMPLE.stats.events}</b><p class="small">Summer events</p></div>
      </div></div>
      <div class="card"><h2>This week</h2><div class="list">${SAMPLE.week.map((w) => `
        <div><span aria-hidden="true" class="box${w.done ? ' on' : ''}"></span>
        <span><b class="${w.done ? 'struck' : ''}">${esc(w.t)}</b><br><span class="small">${esc(w.d)}</span></span></div>`).join('')}
      </div></div>`;
  },
  schools() {
    return `${sampleBanner()}<h1>Target schools</h1>
      <div class="banner info">Balanced list: 3 reach · 7 target · 4 likely</div>
      ${SAMPLE.schools.map((s) => `<div class="card"><div class="row"><span><b>${esc(s.n)}</b><br><span class="small">${esc(s.m)}</span></span><span class="chip c-${s.tier.toLowerCase()}">${s.tier}</span></div></div>`).join('')}`;
  },
  coaches() {
    return `${sampleBanner()}<h1>Coach outreach</h1>
      <div class="banner warn"><span><b>Rule check</b>D1 coaches can’t start recruiting conversations until Sept 1 of junior year, but players can email them now.</span></div>
      ${SAMPLE.coaches.map((c) => `<div class="card"><div class="row"><span><b>${esc(c.n)}</b><br><span class="small">${esc(c.m)}</span></span><span class="chip ${c.c}">${c.s}</span></div></div>`).join('')}`;
  },
  events() {
    return `${sampleBanner()}<h1>Summer plan</h1>
      ${SAMPLE.events.map((e) => `<div class="card"><div class="row start"><b style="min-width:56px">${esc(e.d)}</b><span><b>${esc(e.n)}</b><br><span class="small">${esc(e.m)}</span></span></div></div>`).join('')}`;
  },
};
