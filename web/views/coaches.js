// Coaches tab: pipeline (#/coaches), add a coach (#/coaches/add[/schoolId]) and one coach (#/coaches/<id>)
// with the outreach log, AI draft, compose links and tracked card link.
import {
  doc, collection, addDoc, updateDoc, writeBatch, query, where, getDocs, orderBy, onSnapshot,
  serverTimestamp, Timestamp, increment,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { $, esc, options, formToObject, fmtDay, errorText } from '../util.js';
import { contactOpensDate, afterSophomoreDate, startOfDay, addDays } from '../lib/plan.js';
import { sampleViews } from './sample.js';
import { playerSwitcher, bindSwitcher } from './home.js';

export const STAGES = [
  { value: 'to_email', label: 'To email' }, { value: 'emailed', label: 'Emailed' },
  { value: 'replied', label: 'Replied' }, { value: 'call', label: 'Call' },
  { value: 'visit', label: 'Visit' }, { value: 'offer', label: 'Offer' },
];
const ROLES = [
  { value: 'head', label: 'Head coach' }, { value: 'assistant', label: 'Assistant coach' },
  { value: 'recruiting_coordinator', label: 'Recruiting coordinator' }, { value: 'other', label: 'Other staff' },
];
const TOUCH_TYPES = [
  { value: 'email_out', label: 'Email sent' }, { value: 'reply_in', label: 'Coach replied' },
  { value: 'call', label: 'Phone or video call' }, { value: 'camp', label: 'Saw them at a camp or event' },
  { value: 'visit', label: 'Campus visit' }, { value: 'note', label: 'Note' },
];
const roleLabel = (v) => ROLES.find((r) => r.value === v)?.label || 'Coach';
const stageLabel = (v) => STAGES.find((s) => s.value === v)?.label || 'To email';

/** What logging a touch does to the contact: new stage and the next follow-up date. Pure. */
export function afterTouch(contact, type, at = new Date()) {
  const rank = Object.fromEntries(STAGES.map((s, i) => [s.value, i]));
  const bump = { email_out: 'emailed', reply_in: 'replied', call: 'call', visit: 'visit' }[type];
  const stage = bump && rank[bump] > (rank[contact.stage] ?? 0) ? bump : (contact.stage || 'to_email');
  const days = { email_out: 14, reply_in: 3, call: 21, visit: 21, camp: 7 }[type];
  const out = { stage, lastTouchAt: at, touchCount: (contact.touchCount || 0) + 1 };
  if (days) out.nextFollowUpAt = addDays(at, days);
  if (type === 'reply_in') out.lastReplyAt = at;
  return out;
}

/** "Follow up" chip when the follow-up date has passed. */
function contactChip(c) {
  const due = c.nextFollowUpAt && c.nextFollowUpAt.toDate() <= new Date();
  if (due && c.stage === 'replied') return '<span class="chip c-reach">Reply</span>';
  if (due) return '<span class="chip c-reach">Follow up</span>';
  const cls = { replied: 'c-likely', call: 'c-likely', visit: 'c-likely', offer: 'c-likely', emailed: 'c-target' }[c.stage] || 'c-muted';
  return `<span class="chip ${cls}">${stageLabel(c.stage)}</span>`;
}

/** The rule check shown on the Coaches tab, from the player's divisions and today's date. */
export function ruleCheck(p, today = new Date()) {
  const t = startOfDay(today);
  const d1 = contactOpensDate(p.gradYear); const d2 = afterSophomoreDate(p.gradYear);
  const open = p.openDivisions || [];
  const parts = [];
  if (open.includes('D1')) {
    parts.push(t >= d1 ? 'D1 coaches can now call, text and email you back.'
      : `D1 coaches can’t start recruiting conversations until Sept 1, ${p.gradYear - 2}, but ${p.firstName} can email them now.`);
  }
  if (open.includes('D2')) parts.push(t >= d2 ? 'D2 coaches can contact you now.' : `D2 coaches can contact you from June 15, ${p.gradYear - 2}.`);
  if (open.includes('D3')) parts.push('D3 coaches have fewer contact limits; check each school.');
  return parts.join(' ');
}

// ---------- live data for this tab ----------
let liveKey = null; let unsubContacts = null; let unsubTouches = null;
function watch(ctx) {
  const p = ctx.currentPlayer();
  const key = `${ctx.state.claims.fid}/${p.id}`;
  if (key === liveKey) return;
  unsubContacts?.(); unsubTouches?.();
  liveKey = key;
  ctx.state.contacts = null; ctx.state.touches = null;
  const base = `families/${ctx.state.claims.fid}/players/${p.id}`;
  unsubContacts = onSnapshot(collection(ctx.db, `${base}/contacts`), (s) => {
    ctx.state.contacts = s.docs.map((d) => ({ id: d.id, ...d.data() })); ctx.rerender();
  }, (e) => console.error('contacts', e));
  unsubTouches = onSnapshot(query(collection(ctx.db, `${base}/touches`), orderBy('at', 'desc')), (s) => {
    ctx.state.touches = s.docs.map((d) => ({ id: d.id, ...d.data() })); ctx.rerender();
  }, (e) => console.error('touches', e));
}
export function stopCoachWatch() { unsubContacts?.(); unsubTouches?.(); liveKey = null; }

const base = (ctx) => `families/${ctx.state.claims.fid}/players/${ctx.currentPlayer().id}`;

// ---------- pipeline ----------
function listView(ctx) {
  const p = ctx.currentPlayer();
  const contacts = ctx.state.contacts;
  if (!contacts) return '<p class="muted" role="status">Loading coaches…</p>';
  const count = (fn) => contacts.filter(fn).length;
  const counts = {
    toEmail: count((c) => !c.stage || c.stage === 'to_email'),
    emailed: count((c) => c.stage === 'emailed'),
    replied: count((c) => c.stage === 'replied'),
    calls: count((c) => ['call', 'visit', 'offer'].includes(c.stage)),
  };
  const sorted = [...contacts].sort((a, b) => (a.nextFollowUpAt?.toMillis?.() ?? Infinity) - (b.nextFollowUpAt?.toMillis?.() ?? Infinity) || String(a.schoolName).localeCompare(String(b.schoolName)));
  return `${playerSwitcher(ctx)}
    <div class="row"><h1>Coach outreach</h1><a class="btn btn-primary btn-sm" href="#/coaches/add">Add coach</a></div>
    <div class="pipe" id="pipeline">
      <div><b>${counts.toEmail}</b><span>To email</span></div><div><b>${counts.emailed}</b><span>Emailed</span></div>
      <div><b>${counts.replied}</b><span>Replied</span></div><div class="hl"><b>${counts.calls}</b><span>Calls+</span></div>
    </div>
    <div class="banner warn" role="note"><span><b>Rule check</b>${esc(ruleCheck(p))}</span></div>
    ${sorted.map((c) => `<a class="card link-card" href="#/coaches/${esc(c.id)}"><div class="row">
      <span class="row start"><span class="avatar sq" aria-hidden="true">${esc((c.schoolName || '?').slice(0, 2).toUpperCase())}</span>
      <span><b>${esc(c.schoolName)}</b><br><span class="small">${esc(c.name || roleLabel(c.role))} · ${c.lastTouchAt ? `last contact ${fmtDay(c.lastTouchAt.toDate())}` : 'not contacted yet'}</span></span></span>
      ${contactChip(c)}</div></a>`).join('')}
    ${!contacts.length ? `<div class="card"><h2>Add your first coach</h2><p class="muted">Pick a school from your list, add the coach’s name and email from the school’s staff page, and LaxHQ tracks every email, reply and follow-up.</p><a class="btn btn-primary" href="#/coaches/add">Add a coach</a></div>` : ''}`;
}

// ---------- add ----------
function addView(ctx, schoolId) {
  const targets = [...ctx.state.targets].sort((a, b) => a.name.localeCompare(b.name));
  if (!targets.length) {
    return `<a class="back" href="#/coaches">← Coaches</a><h1>Add a coach</h1>
      <div class="card"><p class="muted">Coaches are added for schools on your list. Add a school first.</p><a class="btn btn-primary" href="#/schools/add">Add a school</a></div>`;
  }
  const sel = schoolId && targets.some((t) => t.id === schoolId) ? schoolId : '';
  const t = targets.find((x) => x.id === sel);
  const sugg = ctx.state.ui.suggestions;
  const msg = ctx.state.ui.addCoachMsg;
  return `<a class="back" href="#/coaches">← Coaches</a><h1>Add a coach</h1>
    ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
    <form id="coach-form" class="card" novalidate data-keep>
      <div class="field"><label for="co-school">School</label><select id="co-school" name="schoolId">${options(targets.map((x) => ({ value: x.id, label: x.name })), sel, { blank: 'Choose a school on your list' })}</select></div>
      ${t?.questionnaireUrl ? `<a href="${esc(t.questionnaireUrl)}" target="_blank" rel="noopener">Fill in ${esc(t.name)}’s recruiting questionnaire ↗</a>` : ''}
      ${sugg && sugg.schoolId === sel && sugg.list.length ? `<div class="field" id="suggestions"><span class="label">Coaches other LaxHQ families have confirmed</span>
        ${sugg.list.map((c) => `<button type="button" class="btn btn-ghost btn-sm sugg" data-sugg="${esc(c.id)}">${esc(c.name || c.email)} · ${esc(roleLabel(c.role))}</button>`).join('')}</div>` : ''}
      <div class="field"><label for="co-name">Coach name</label><input id="co-name" name="name" maxlength="80" required></div>
      <div class="two">
        <div class="field"><label for="co-role">Role</label><select id="co-role" name="role">${options(ROLES, 'head')}</select></div>
        <div class="field"><label for="co-email">Email</label><input id="co-email" name="email" type="email" maxlength="120" placeholder="From the school’s staff page"></div>
      </div>
      <button class="btn btn-primary" type="submit">Add coach</button>
    </form>`;
}

async function loadSuggestions(ctx, schoolId) {
  const t = ctx.state.targets.find((x) => x.id === schoolId);
  if (!t || t.custom || !t.schoolId) { ctx.setUi('suggestions', { schoolId, list: [] }); return; }
  try {
    const q = query(collection(ctx.db, 'coaches'), where('schoolId', '==', t.schoolId), where('sport', '==', ctx.currentPlayer().sport), where('status', '==', 'active'));
    const s = await getDocs(q);
    ctx.setUi('suggestions', { schoolId, list: s.docs.map((d) => ({ id: d.id, ...d.data() })) });
  } catch (e) { console.error(e); ctx.setUi('suggestions', { schoolId, list: [] }); }
}

// ---------- one coach ----------
function composeLinks(to, subject, body) {
  const e = encodeURIComponent;
  return {
    mailto: `mailto:${encodeURI(to || '')}?subject=${e(subject)}&body=${e(body)}`,
    gmail: `https://mail.google.com/mail/?view=cm&fs=1&to=${e(to || '')}&su=${e(subject)}&body=${e(body)}`,
    outlook: `https://outlook.office.com/mail/deeplink/compose?to=${e(to || '')}&subject=${e(subject)}&body=${e(body)}`,
  };
}

function detailView(ctx, id) {
  const c = (ctx.state.contacts || []).find((x) => x.id === id);
  if (!ctx.state.contacts) return '<p class="muted" role="status">Loading…</p>';
  if (!c) return '<a class="back" href="#/coaches">← Coaches</a><p class="muted">That coach was not found.</p>';
  const p = ctx.currentPlayer();
  const ui = ctx.state.ui;
  const draft = ui.draft?.contactId === id ? ui.draft : null;
  const touches = (ctx.state.touches || []).filter((x) => x.contactId === id);
  const links = draft ? composeLinks(c.email, draft.subject, draft.body) : null;
  const firstEmail = !touches.some((x) => x.type === 'email_out');
  const msg = ui.coachMsg;
  return `<a class="back" href="#/coaches">← Coaches</a>
    <div class="row"><div><h1>${esc(c.name || 'Coach')}</h1><p class="small">${esc(roleLabel(c.role))} · <a href="#/schools/${esc(c.schoolId)}">${esc(c.schoolName)}</a></p></div>${contactChip(c)}</div>
    ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
    <section class="card">
      <p><span class="small">Email</span><br><b class="wrapword">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : 'Not added yet'}</b></p>
      <div class="fits"><span><span class="small">Stage</span><b>${esc(stageLabel(c.stage))}</b></span>
        <span><span class="small">Next follow-up</span><b>${c.nextFollowUpAt ? fmtDay(c.nextFollowUpAt.toDate()) : '—'}</b></span>
        <span><span class="small">Card views</span><b>${c.cardViews || 0}</b></span></div>
      <div class="field"><label for="co-stage">Stage</label><select id="co-stage">${options(STAGES, c.stage || 'to_email')}</select></div>
      <div class="row start wrap">
        <button class="btn btn-ghost btn-sm" id="card-link-btn">Copy tracked card link</button>
        ${c.coachId ? '<button class="btn btn-ghost btn-sm" id="report-coach">Report wrong email</button>' : ''}
      </div>
      ${ui.cardLink?.contactId === id ? `<div class="copy"><input id="tracked-link" readonly value="${esc(ui.cardLink.url)}" aria-label="Tracked card link"></div>` : ''}
    </section>

    <section class="card" id="draft-card">
      <h2>${firstEmail ? 'Write the first email' : 'Write a follow-up'}</h2>
      <p class="small">LaxHQ drafts it from ${esc(p.firstName)}’s profile, card and summer schedule. You review it and send it from your own email.</p>
      ${!draft ? `<div class="field"><label for="draft-note">Anything to mention? (optional)</label><input id="draft-note" maxlength="300" placeholder="e.g. Loved the campus visit in October"></div>
        <button class="btn btn-primary" id="write-draft" data-kind="${firstEmail ? 'intro' : 'followup'}">${ui.drafting ? 'Writing…' : 'Write draft'}</button>`
    : `<div class="field"><label for="draft-subject">Subject</label><input id="draft-subject" value="${esc(draft.subject)}"></div>
        <div class="field"><label for="draft-body">Email</label><textarea id="draft-body" rows="12">${esc(draft.body)}</textarea></div>
        <p class="small">Open it in your email app, send it, then come back and tap “I sent it”.</p>
        <div class="row start wrap compose">
          <a class="btn btn-dark btn-sm" id="open-mail" href="${esc(links.mailto)}">Email app</a>
          <a class="btn btn-ghost btn-sm" href="${esc(links.gmail)}" target="_blank" rel="noopener">Gmail</a>
          <a class="btn btn-ghost btn-sm" href="${esc(links.outlook)}" target="_blank" rel="noopener">Outlook</a>
          <button class="btn btn-ghost btn-sm" id="copy-draft">Copy</button>
        </div>
        <div class="row start wrap"><button class="btn btn-primary" id="mark-sent">I sent it</button><button class="link" id="discard-draft">Discard draft</button></div>
        ${draft.remaining != null ? `<p class="small">${draft.remaining} AI drafts left this month.</p>` : ''}`}
    </section>

    <form id="touch-form" class="card" novalidate>
      <h2>Log contact</h2>
      <div class="two">
        <div class="field"><label for="tt-type">What happened</label><select id="tt-type" name="type">${options(TOUCH_TYPES, 'reply_in')}</select></div>
        <div class="field"><label for="tt-date">Date</label><input id="tt-date" name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="field"><label for="tt-note">Notes</label><textarea id="tt-note" name="note" rows="3" maxlength="2000"></textarea></div>
      <button class="btn btn-dark" type="submit">Save</button>
    </form>

    <section class="card"><h2>History</h2>
      ${touches.length ? `<div class="list">${touches.map((x) => `<div><span class="grow"><b>${esc(TOUCH_TYPES.find((tt) => tt.value === x.type)?.label || x.type)}</b>${x.aiDrafted ? ' <span class="chip c-muted">AI draft</span>' : ''}<br>
        <span class="small">${fmtDay(x.at?.toDate?.() || x.at)}${x.subject ? ` · ${esc(x.subject)}` : ''}${x.note ? ` · ${esc(x.note)}` : ''}</span></span></div>`).join('')}</div>` : '<p class="muted">Nothing logged yet.</p>'}
    </section>
    <button class="btn btn-ghost" id="delete-coach">Remove coach</button>`;
}

async function logTouch(ctx, contact, { type, at, subject = null, body = null, note = null, aiDrafted = false }) {
  const b = base(ctx);
  const batch = writeBatch(ctx.db);
  batch.set(doc(collection(ctx.db, `${b}/touches`)), {
    contactId: contact.id, schoolId: contact.schoolId || null, type, at: Timestamp.fromDate(at),
    subject, body, note, aiDrafted, createdBy: ctx.state.user.uid,
  });
  const next = afterTouch(contact, type, at);
  batch.update(doc(ctx.db, `${b}/contacts/${contact.id}`), {
    stage: next.stage, lastTouchAt: Timestamp.fromDate(next.lastTouchAt), touchCount: increment(1),
    ...(next.nextFollowUpAt ? { nextFollowUpAt: Timestamp.fromDate(next.nextFollowUpAt) } : {}),
    ...(next.lastReplyAt ? { lastReplyAt: Timestamp.fromDate(next.lastReplyAt) } : {}),
  });
  await batch.commit();
}

// ---------- screen ----------
export default {
  render(ctx, args) {
    if (!ctx.isPro() || !ctx.currentPlayer()) return sampleViews.coaches();
    watch(ctx);
    if (args[0] === 'add') return addView(ctx, args[1] ? decodeURIComponent(args[1]) : ctx.state.ui.addSchool);
    if (args[0]) return detailView(ctx, decodeURIComponent(args[0]));
    return listView(ctx);
  },
  bind(ctx, args) {
    bindSwitcher(ctx);
    if (args[0] === 'add') {
      const sel = $('co-school');
      if (sel) {
        if (sel.value && ctx.state.ui.suggestions?.schoolId !== sel.value) loadSuggestions(ctx, sel.value);
        sel.addEventListener('change', () => { ctx.state.ui.addSchool = sel.value; loadSuggestions(ctx, sel.value); });
      }
      document.querySelectorAll('[data-sugg]').forEach((b) => b.addEventListener('click', () => {
        const c = ctx.state.ui.suggestions.list.find((x) => x.id === b.dataset.sugg);
        $('co-name').value = c.name || ''; $('co-email').value = c.email || ''; if (c.role) $('co-role').value = c.role;
        ['co-name', 'co-email', 'co-role'].forEach((i) => { $(i).dataset.dirty = '1'; });
      }));
      $('coach-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = formToObject(e.target);
        const t = ctx.state.targets.find((x) => x.id === d.schoolId);
        if (!t) { ctx.setUi('addCoachMsg', { text: 'Choose a school.', bad: true }); return; }
        if (!d.name) { ctx.setUi('addCoachMsg', { text: 'Enter the coach’s name.', bad: true }); return; }
        if (d.email && !/^\S+@\S+\.\S+$/.test(d.email)) { ctx.setUi('addCoachMsg', { text: 'That email doesn’t look right.', bad: true }); return; }
        try {
          const ref = await addDoc(collection(ctx.db, `${base(ctx)}/contacts`), {
            schoolId: t.id, schoolName: t.name, name: d.name.slice(0, 80), role: d.role, email: d.email ? d.email.trim().toLowerCase() : null,
            stage: 'to_email', touchCount: 0, coachId: null, createdAt: serverTimestamp(),
          });
          ctx.navigate(`#/coaches/${ref.id}`);
        } catch (err) { ctx.setUi('addCoachMsg', { text: errorText(err), bad: true }); }
      });
      return;
    }
    if (!args[0]) return;

    const id = decodeURIComponent(args[0]);
    const c = (ctx.state.contacts || []).find((x) => x.id === id);
    if (!c) return;
    const ref = doc(ctx.db, `${base(ctx)}/contacts/${id}`);
    const p = ctx.currentPlayer();

    $('co-stage')?.addEventListener('change', (e) => updateDoc(ref, { stage: e.target.value })
      .then(() => ctx.setUi('coachMsg', { text: 'Stage saved.' })).catch((err) => ctx.setUi('coachMsg', { text: errorText(err), bad: true })));
    $('card-link-btn')?.addEventListener('click', async () => {
      try {
        const { url } = await ctx.call('contactCardLink', { playerId: p.id, contactId: id, appOrigin: location.origin });
        ctx.state.ui.cardLink = { contactId: id, url };
        try { await navigator.clipboard.writeText(url); ctx.setUi('coachMsg', { text: 'Tracked link copied. Views from it show this school.' }); } catch { ctx.setUi('coachMsg', { text: 'Here’s the tracked link.' }); }
      } catch (err) { ctx.setUi('coachMsg', { text: errorText(err), bad: true }); }
    });
    $('report-coach')?.addEventListener('click', async () => {
      const bounced = confirm('Did an email to this address bounce? OK = bounced, Cancel = the address is wrong.');
      try {
        await ctx.call('reportCoach', { coachId: c.coachId, reason: bounced ? 'bounced' : 'wrong_email' });
        ctx.setUi('coachMsg', { text: 'Thanks. Other families won’t be offered this email.' });
      } catch (err) { ctx.setUi('coachMsg', { text: errorText(err), bad: true }); }
    });
    $('write-draft')?.addEventListener('click', async (e) => {
      if (ctx.state.ui.drafting) return;
      ctx.state.ui.drafting = true; e.target.textContent = 'Writing…'; e.target.disabled = true;
      try {
        const res = await ctx.call('aiDraftEmail', { playerId: p.id, contactId: id, kind: e.target.dataset.kind, note: $('draft-note').value || null, appOrigin: location.origin });
        ctx.state.ui.drafting = false;
        ctx.setUi('draft', { contactId: id, kind: e.target.dataset.kind, ...res });
      } catch (err) { ctx.state.ui.drafting = false; ctx.setUi('coachMsg', { text: errorText(err), bad: true }); }
    });
    const syncDraft = () => {
      const d = ctx.state.ui.draft; if (!d) return;
      d.subject = $('draft-subject').value; d.body = $('draft-body').value;
      const links = composeLinks(c.email, d.subject, d.body);
      $('open-mail').href = links.mailto;
      const [gm, ol] = document.querySelectorAll('.compose a[target]'); gm.href = links.gmail; ol.href = links.outlook;
    };
    $('draft-subject')?.addEventListener('input', syncDraft);
    $('draft-body')?.addEventListener('input', syncDraft);
    $('copy-draft')?.addEventListener('click', async () => {
      syncDraft();
      try { await navigator.clipboard.writeText(`${$('draft-subject').value}\n\n${$('draft-body').value}`); ctx.setUi('coachMsg', { text: 'Draft copied.' }); } catch { ctx.setUi('coachMsg', { text: 'Select the text and copy it.' }); }
    });
    $('discard-draft')?.addEventListener('click', () => ctx.setUi('draft', null));
    $('mark-sent')?.addEventListener('click', async () => {
      syncDraft();
      const d = ctx.state.ui.draft;
      try {
        await logTouch(ctx, c, { type: 'email_out', at: new Date(), subject: d.subject, body: d.body, aiDrafted: true });
        ctx.state.ui.draft = null;
        ctx.setUi('coachMsg', { text: 'Logged. LaxHQ will remind you to follow up in 2 weeks if there’s no reply.' });
      } catch (err) { ctx.setUi('coachMsg', { text: errorText(err), bad: true }); }
    });
    $('touch-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formToObject(e.target);
      const at = d.date ? new Date(`${d.date}T12:00:00`) : new Date();
      try {
        await logTouch(ctx, c, { type: d.type, at, note: d.note ? d.note.slice(0, 2000) : null });
        e.target.reset();
        ctx.setUi('coachMsg', { text: 'Saved.' });
      } catch (err) { ctx.setUi('coachMsg', { text: errorText(err), bad: true }); }
    });
    $('delete-coach')?.addEventListener('click', async () => {
      if (!confirm('Remove this coach and their history?')) return;
      try {
        const own = (ctx.state.touches || []).filter((x) => x.contactId === id);
        const batch = writeBatch(ctx.db);
        own.forEach((x) => batch.delete(doc(ctx.db, `${base(ctx)}/touches/${x.id}`)));
        batch.delete(ref);
        await batch.commit();
        ctx.navigate('#/coaches');
      } catch (err) { ctx.setUi('coachMsg', { text: errorText(err), bad: true }); }
    });
  },
};
