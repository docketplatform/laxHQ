// Schools tab: the target list (#/schools), search-and-add (#/schools/add) and
// one school's detail with "How you compare" (#/schools/<id>).
import {
  doc, getDoc, writeBatch, increment, serverTimestamp, updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { $, esc, formToObject, options, errorText } from '../util.js';
import { targetFit, listBalance, normalizeGpa, defaultAthleticTier, TIERS } from '../lib/fit.js';
import { STATES } from '../lib/options.js';
import { sampleViews } from './sample.js';
import { playerSwitcher, bindSwitcher } from './home.js';

const TIER_LABEL = { reach: 'Reach', target: 'Target', likely: 'Likely' };
const STATUSES = [
  { value: 'researching', label: 'Researching' }, { value: 'contacted', label: 'Contacted' },
  { value: 'engaged', label: 'Talking with coaches' }, { value: 'visited', label: 'Visited' },
  { value: 'offer', label: 'Offer' }, { value: 'committed', label: 'Committed' }, { value: 'dropped', label: 'Dropped' },
];
const statusLabel = (v) => STATUSES.find((s) => s.value === v)?.label || 'Researching';
const chip = (tier) => (tier ? `<span class="chip c-${tier}">${TIER_LABEL[tier]}</span>` : '<span class="chip c-muted">Not rated</span>');

// ---------- catalog (compact index, loaded once) ----------
let catalogPromise = null;
function loadCatalog(ctx) {
  if (ctx.state.catalog) return Promise.resolve(ctx.state.catalog);
  catalogPromise ||= getDoc(doc(ctx.db, 'catalog/index')).then((s) => {
    const rows = (s.data()?.rows || []).map((r) => {
      const [id, name, city, state, mlax, wlax, mlaxConf, wlaxConf] = r.split('|');
      return { id, name, city, state, div: { mlax, wlax }, conf: { mlax: mlaxConf, wlax: wlaxConf } };
    });
    ctx.state.catalog = rows;
    return rows;
  }).catch((e) => { catalogPromise = null; throw e; });
  return catalogPromise;
}

const targetsRef = (ctx) => `families/${ctx.state.claims.fid}/players/${ctx.currentPlayer().id}`;

/** Add a school (catalog or custom) with the targetCount bump the rules require. */
async function addTarget(ctx, id, data) {
  const base = targetsRef(ctx);
  const batch = writeBatch(ctx.db);
  batch.set(doc(ctx.db, `${base}/targets/${id}`), {
    ...data, status: 'researching', priority: 3, notes: '', tierOverride: null,
    addedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  batch.update(doc(ctx.db, base), { targetCount: increment(1) });
  await batch.commit();
}

async function removeTarget(ctx, id) {
  const base = targetsRef(ctx);
  const batch = writeBatch(ctx.db);
  batch.delete(doc(ctx.db, `${base}/targets/${id}`));
  batch.update(doc(ctx.db, base), { targetCount: increment(-1) });
  await batch.commit();
}

/** Snapshot of the school stored on the target, so fit works without extra reads. */
function schoolSnapshot(school, sport) {
  const prog = school.programs?.[sport] || {};
  return {
    academics: school.academics || null,
    athleticTier: prog.athleticTier ?? defaultAthleticTier(prog.division, prog.conference),
  };
}

// ---------- list ----------
function listView(ctx) {
  const p = ctx.currentPlayer();
  const filter = ctx.state.ui.schoolFilter || 'All';
  const rows = ctx.state.targets.map((t) => ({ t, f: targetFit(p, t) }));
  const balance = listBalance(rows.filter((r) => r.t.status !== 'dropped').map((r) => r.f.tier));
  const shown = rows.filter((r) => filter === 'All' || r.t.division === filter)
    .sort((a, b) => (a.t.priority ?? 3) - (b.t.priority ?? 3) || a.t.name.localeCompare(b.t.name));
  const { counts } = balance;
  return `${playerSwitcher(ctx)}
    <div class="row"><h1>Target schools</h1><a class="btn btn-primary btn-sm" href="#/schools/add">Add school</a></div>
    ${rows.length ? `<div class="banner info" id="balance" style="display:block">Your list: <b style="display:inline">${counts.reach} reach · ${counts.target} target · ${counts.likely} likely</b>${counts.unrated ? ` · ${counts.unrated} not rated` : ''}</div>` : ''}
    ${balance.warning ? `<div class="banner warn" role="note" id="balance-warning">${esc(balance.warning)}</div>` : ''}
    ${rows.length ? `<div class="seg" role="tablist" aria-label="Division">${['All', 'D1', 'D2', 'D3'].map((d) => `<button role="tab" aria-selected="${d === filter}" data-filter="${d}">${d}</button>`).join('')}</div>` : ''}
    ${shown.map(({ t, f }) => `<a class="card link-card" href="#/schools/${esc(t.id)}">
      <div class="row"><span><b>${esc(t.name)}</b><br><span class="small">${esc([t.division, t.conference, [t.city, t.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))}</span></span>${chip(f.tier)}</div>
      <div class="fits"><span><span class="small">Athletic</span><b>${f.athletic ? TIER_LABEL[f.athletic] : '—'}</b></span><span><span class="small">Academic</span><b>${f.academic ? TIER_LABEL[f.academic] : '—'}</b></span><span><span class="small">Status</span><b>${esc(statusLabel(t.status))}</b></span></div>
    </a>`).join('')}
    ${!rows.length ? `<div class="card"><h2>Start your list</h2><p class="muted">Add 15–25 schools across the divisions you’re open to: a few reaches, mostly targets and some likely schools. Each one gets an athletic and academic fit estimate.</p><a class="btn btn-primary" href="#/schools/add">Add your first school</a></div>` : ''}
    ${rows.length && !shown.length ? `<p class="muted">No ${filter} schools on the list.</p>` : ''}`;
}

// ---------- add ----------
function addView(ctx) {
  const p = ctx.currentPlayer();
  const q = (ctx.state.ui.schoolQuery || '').toLowerCase().trim();
  const div = ctx.state.ui.addDivision || '';
  const have = new Set(ctx.state.targets.map((t) => t.id));
  const catalog = ctx.state.catalog;
  let results = '';
  if (!catalog) results = '<p class="muted" role="status">Loading schools…</p>';
  else {
    const list = catalog.filter((s) => s.div[p.sport]
      && (!div || s.div[p.sport] === div)
      && (!q || s.name.toLowerCase().includes(q) || s.city.toLowerCase().includes(q) || s.state.toLowerCase() === q || (s.conf[p.sport] || '').toLowerCase().includes(q)));
    results = list.length ? `<div class="list" id="results">${list.slice(0, 40).map((s) => `<div>
      <span class="grow"><b>${esc(s.name)}</b><br><span class="small">${esc(s.div[p.sport])} · ${esc(s.conf[p.sport])} · ${esc(s.city)}, ${esc(s.state)}</span></span>
      ${have.has(s.id) ? '<span class="chip c-likely">On your list</span>' : `<button class="btn btn-dark btn-sm" data-add="${esc(s.id)}">Add</button>`}
    </div>`).join('')}</div>${list.length > 40 ? `<p class="small">Showing 40 of ${list.length}. Type more to narrow it down.</p>` : ''}`
      : '<p class="muted">No schools match. Add it as a custom school below.</p>';
  }
  const msg = ctx.state.ui.addMsg;
  return `<a class="back" href="#/schools">← Schools</a><h1>Add a school</h1>
    <p class="muted">${ctx.state.targets.length} on ${esc(p.firstName)}’s list. Showing ${p.sport === 'wlax' ? 'women’s' : 'men’s'} programs.</p>
    <div class="two"><div class="field"><label for="school-q">Search</label><input id="school-q" type="search" value="${esc(ctx.state.ui.schoolQuery || '')}" placeholder="Name, city, state or conference" autocomplete="off"></div>
    <div class="field"><label for="school-div">Division</label><select id="school-div">${options(['D1', 'D2', 'D3'], div, { blank: 'All' })}</select></div></div>
    ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
    <div class="card">${results}</div>
    <form id="custom-school" class="card" novalidate>
      <h2>Not listed? Add it yourself</h2>
      <div class="field"><label for="cs-name">School name</label><input id="cs-name" name="name" maxlength="100" required></div>
      <div class="three">
        <div class="field"><label for="cs-div">Division</label><select id="cs-div" name="division">${options(['D1', 'D2', 'D3', 'NAIA', 'JUCO'], 'D3')}</select></div>
        <div class="field"><label for="cs-state">State</label><select id="cs-state" name="state">${options(STATES, '', { blank: 'Choose' })}</select></div>
        <div class="field"><label for="cs-conf">Conference</label><input id="cs-conf" name="conference" maxlength="60"></div>
      </div>
      <button class="btn btn-dark" type="submit">Add custom school</button>
    </form>`;
}

// ---------- detail ----------
function detailView(ctx, id) {
  const p = ctx.currentPlayer();
  const t = ctx.state.targets.find((x) => x.id === id);
  if (!t) return `<a class="back" href="#/schools">← Schools</a><p class="muted">That school isn’t on ${esc(p.firstName)}’s list.</p>`;
  const f = targetFit(p, t);
  const ac = t.school?.academics || {};
  const pa = p.academics || {};
  const msg = ctx.state.ui.targetMsg;
  const gpaBar = (v) => Math.max(0, Math.min(100, Math.round((v / 4) * 100)));
  const myGpa = pa.gpa != null ? normalizeGpa(pa.gpa, pa.gpaScale, pa.weighted) : null;

  return `<a class="back" href="#/schools">← Schools</a>
    <div class="row"><div><h1>${esc(t.name)}</h1><p class="small">${esc([t.division, t.conference, [t.city, t.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))}${t.custom ? ' · added by you' : ''}</p></div>${chip(f.tier)}</div>
    ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
    <section class="card" id="fit">
      <h2>Fit</h2>
      <div class="fits"><span><span class="small">Athletic</span><b>${f.athletic ? TIER_LABEL[f.athletic] : 'Not enough info'}</b></span><span><span class="small">Academic</span><b>${f.academic ? TIER_LABEL[f.academic] : 'Not enough info'}</b></span><span><span class="small">Overall</span><b>${f.computed ? TIER_LABEL[f.computed] : '—'}</b></span></div>
      <p class="small">Estimates. Athletic fit uses club level, varsity and all-conference status and any rankings on the profile${f.academicBasis ? `; academic fit uses ${esc(f.academicBasis)}` : ''}.</p>
      <div class="field"><label for="tier-override">Your call</label><select id="tier-override">${options([{ value: '', label: f.computed ? `Use the estimate (${TIER_LABEL[f.computed]})` : 'Not rated' }, ...TIERS.map((x) => ({ value: x, label: TIER_LABEL[x] }))], t.tierOverride || '')}</select></div>
    </section>
    <section class="card" id="compare">
      <h2>How you compare</h2>
      ${ac.avgHsGpa != null && myGpa != null ? `<div class="cmp">
        <div class="row small-row"><span>${esc(p.firstName)} · GPA</span><b>${myGpa}</b></div><div class="meter"><i class="me" style="width:${gpaBar(myGpa)}%"></i></div>
        <div class="row small-row"><span>Admitted students · average GPA</span><b>${ac.avgHsGpa}</b></div><div class="meter"><i style="width:${gpaBar(ac.avgHsGpa)}%"></i></div></div>` : ''}
      ${ac.sat25 != null ? `<p class="small">Admitted students’ SAT middle 50%: <b>${ac.sat25}–${ac.sat75}</b>${pa.sat ? ` · ${esc(p.firstName)}: <b>${pa.sat}</b>` : ''}</p>` : ''}
      ${ac.act25 != null ? `<p class="small">ACT middle 50%: <b>${ac.act25}–${ac.act75}</b>${pa.act ? ` · ${esc(p.firstName)}: <b>${pa.act}</b>` : ''}</p>` : ''}
      ${ac.admitRate != null ? `<p class="small">Admit rate: <b>${Math.round(ac.admitRate * 100)}%</b></p>` : ''}
      ${ac.avgHsGpa == null && ac.sat25 == null && ac.admitRate == null ? '<p class="muted">Admissions data for this school isn’t loaded yet.</p>' : ''}
      ${myGpa == null && !pa.sat && !pa.act ? '<p class="small">Add a GPA or test score on the Profile tab to compare.</p>' : ''}
      <p class="small">Compared with all admitted students. The bar for recruited athletes can differ, especially at very selective schools.</p>
      ${ctx.state.ui.stats?.id === t.schoolId && ctx.state.ui.stats.committed ? `<p class="small">LaxHQ families who committed here: average GPA <b>${ctx.state.ui.stats.committed.avgGpa}</b> (${ctx.state.ui.stats.committed.count} families shared).</p>` : ''}
      <p class="small">Roster connections (players from your club, high school and state) arrive after launch.</p>
    </section>
    ${t.status === 'committed' && !t.outcomeReported && !t.custom ? `<section class="card banner-card" id="outcome">
      <h2>Congratulations!</h2>
      <p>Share ${esc(p.firstName)}’s GPA, anonymously, to help other families see what committed players at ${esc(t.name)} look like? It only appears as an average once 5 or more families share.</p>
      <div class="row start wrap"><button class="btn btn-primary" data-outcome="share">Share anonymously</button><button class="btn btn-ghost" data-outcome="private">Keep it private</button></div>
    </section>` : ''}
    <form id="target-form" class="card" data-keep>
      <h2>Your notes</h2>
      <div class="two">
        <div class="field"><label for="t-status">Status</label><select id="t-status" name="status">${options(STATUSES, t.status)}</select></div>
        <div class="field"><label for="t-priority">Priority</label><select id="t-priority" name="priority" data-type="number">${options([1, 2, 3, 4, 5].map((n) => ({ value: n, label: n === 1 ? '1 · top choice' : String(n) })), t.priority ?? 3)}</select></div>
      </div>
      <div class="field"><label for="t-q">Recruiting questionnaire link</label><input id="t-q" name="questionnaireUrl" type="url" value="${esc(t.questionnaireUrl || '')}" placeholder="https://"></div>
      ${t.questionnaireUrl ? `<a href="${esc(t.questionnaireUrl)}" target="_blank" rel="noopener">Open the questionnaire ↗</a>` : ''}
      <div class="field"><label for="t-notes">Notes</label><textarea id="t-notes" name="notes" maxlength="2000">${esc(t.notes || '')}</textarea></div>
      <button class="btn btn-dark" type="submit">Save</button>
    </form>
    <button class="btn btn-ghost" id="remove-target">Remove from list</button>`;
}

// ---------- screen ----------
export default {
  render(ctx, args) {
    if (!ctx.isPro() || !ctx.currentPlayer()) return sampleViews.schools();
    if (args[0] === 'add') {
      if (!ctx.state.catalog) {
        loadCatalog(ctx).then(() => { if (location.hash.startsWith('#/schools/add')) ctx.setUi('catalogLoaded', true); })
          .catch(() => ctx.setUi('addMsg', { text: 'Could not load the school list.', bad: true }));
      }
      return addView(ctx);
    }
    if (args[0]) return detailView(ctx, decodeURIComponent(args[0]));
    return listView(ctx);
  },
  bind(ctx, args) {
    bindSwitcher(ctx);
    if (!ctx.isPro() || !ctx.currentPlayer()) return; // sample view: nothing to bind
    document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => ctx.setUi('schoolFilter', b.dataset.filter)));

    const q = $('school-q');
    if (q) {
      let timer;
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => ctx.setUi('schoolQuery', q.value), 150); });
      $('school-div').addEventListener('change', (e) => ctx.setUi('addDivision', e.target.value));
    }
    document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      const p = ctx.currentPlayer();
      try {
        const snap = await getDoc(doc(ctx.db, `schools/${b.dataset.add}`));
        const s = snap.data();
        const prog = s.programs?.[p.sport] || {};
        await addTarget(ctx, b.dataset.add, {
          schoolId: b.dataset.add, name: s.name, city: s.city || null, state: s.state || null, sport: p.sport,
          division: prog.division || null, conference: prog.conference || null, custom: false,
          questionnaireUrl: prog.questionnaireUrl || null, school: schoolSnapshot(s, p.sport),
        });
        ctx.setUi('addMsg', { text: `${s.name} added.` });
      } catch (e) { b.disabled = false; ctx.setUi('addMsg', { text: errorText(e, 'Could not add that school.'), bad: true }); }
    }));
    $('custom-school')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formToObject(e.target);
      if (!d.name) { ctx.setUi('addMsg', { text: 'Enter the school’s name.', bad: true }); return; }
      const id = `custom-${Date.now().toString(36)}`;
      try {
        await addTarget(ctx, id, {
          schoolId: null, name: d.name.slice(0, 100), city: null, state: d.state, sport: ctx.currentPlayer().sport,
          division: d.division, conference: d.conference, custom: true, questionnaireUrl: null,
          school: { academics: null, athleticTier: defaultAthleticTier(d.division, d.conference) },
        });
        e.target.reset();
        ctx.setUi('addMsg', { text: `${d.name} added.` });
      } catch (err) { ctx.setUi('addMsg', { text: errorText(err), bad: true }); }
    });

    if (args[0] && args[0] !== 'add') {
      const id = decodeURIComponent(args[0]);
      const ref = doc(ctx.db, `${targetsRef(ctx)}/targets/${id}`);
      $('tier-override')?.addEventListener('change', (e) => updateDoc(ref, { tierOverride: e.target.value || null, updatedAt: serverTimestamp() })
        .then(() => ctx.setUi('targetMsg', { text: 'Saved.' })).catch((err) => ctx.setUi('targetMsg', { text: errorText(err), bad: true })));
      $('target-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formToObject(e.target);
        if (d.questionnaireUrl && !/^https?:\/\//i.test(d.questionnaireUrl)) { ctx.setUi('targetMsg', { text: 'The questionnaire link must start with https://', bad: true }); return; }
        try {
          await updateDoc(ref, { status: d.status, priority: d.priority, notes: (d.notes || '').slice(0, 2000), questionnaireUrl: d.questionnaireUrl || null, updatedAt: serverTimestamp() });
          e.target.querySelectorAll('[data-dirty]').forEach((el) => delete el.dataset.dirty);
          ctx.setUi('targetMsg', { text: 'Saved.' });
        } catch (err) { ctx.setUi('targetMsg', { text: errorText(err), bad: true }); }
      });
      $('remove-target')?.addEventListener('click', async () => {
        if (!confirm('Remove this school from the list?')) return;
        try { await removeTarget(ctx, id); ctx.navigate('#/schools'); } catch (err) { ctx.setUi('targetMsg', { text: errorText(err), bad: true }); }
      });
      document.querySelectorAll('[data-outcome]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await ctx.call('reportOutcome', { playerId: ctx.currentPlayer().id, targetId: id, share: b.dataset.outcome === 'share' });
          await updateDoc(ref, { outcomeReported: true });
          ctx.setUi('targetMsg', { text: b.dataset.outcome === 'share' ? 'Thanks for sharing.' : 'Saved. Nothing was shared.' });
        } catch (err) { ctx.setUi('targetMsg', { text: errorText(err), bad: true }); }
      }));
      const tt = ctx.state.targets.find((x) => x.id === id);
      if (tt?.schoolId && ctx.state.ui.stats?.id !== tt.schoolId) {
        ctx.state.ui.stats = { id: tt.schoolId };
        getDoc(doc(ctx.db, `schoolStats/${tt.schoolId}_${tt.sport}`)).then((s) => {
          if (s.exists() && s.get('committed')) ctx.setUi('stats', { id: tt.schoolId, committed: s.get('committed') });
        }).catch(() => {});
      }
      // Refresh the stored school snapshot if the catalog has newer admissions data.
      const t = ctx.state.targets.find((x) => x.id === id);
      if (t && !t.custom && t.schoolId && !t._refreshed) {
        t._refreshed = true;
        getDoc(doc(ctx.db, `schools/${t.schoolId}`)).then((s) => {
          if (!s.exists()) return;
          const snap = schoolSnapshot(s.data(), t.sport);
          if (JSON.stringify(snap) !== JSON.stringify(t.school)) updateDoc(ref, { school: snap });
        }).catch(() => {});
      }
    }
  },
};
