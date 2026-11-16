// Full grade-by-grade plan with check-off, skip and custom tasks.
import { doc, updateDoc, serverTimestamp, deleteField } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { $, esc, fmtDay, formToObject, errorText } from '../util.js';
import { buildPlan, gradeLabel } from '../lib/plan.js';
import { playerSwitcher, bindSwitcher } from './home.js';

const STATUS = {
  overdue: { label: 'Overdue', cls: 'c-reach' },
  current: { label: 'Now', cls: 'c-target' },
  upcoming: { label: 'Later', cls: 'c-muted' },
  done: { label: 'Done', cls: 'c-likely' },
  skipped: { label: 'Skipped', cls: 'c-muted' },
};

export function checklistItemHtml(i, ctx, { showSkip = false } = {}) {
  const done = i.status === 'done';
  const editable = ctx.can('save');
  const link = i.action?.target ? `#/${i.action.target === 'card' ? 'profile' : i.action.target}` : null;
  return `<div class="item" data-item="${esc(i.id)}">
    <button class="tick${done ? ' on' : ''}" role="checkbox" aria-checked="${done}" aria-label="${esc(i.title)}" data-toggle="${esc(i.id)}"${editable && !i.auto ? '' : ' disabled'}></button>
    <span class="grow"><b class="${done ? 'struck' : ''}">${link && !done ? `<a href="${link}">${esc(i.title)}</a>` : esc(i.title)}</b><br>
      <span class="small">${i.detail ? `${esc(i.detail)} · ` : ''}${i.auto ? 'done from your profile' : i.status === 'upcoming' ? `starts ${fmtDay(i.start)}` : `due ${fmtDay(i.due)}`}</span></span>
    <span class="chip ${STATUS[i.status].cls}">${STATUS[i.status].label}</span>
    ${showSkip && editable && !done ? `<button class="link" data-skip="${esc(i.id)}">${i.status === 'skipped' ? 'Restore' : 'Skip'}</button>` : ''}
  </div>`;
}

function stateRef(ctx) {
  return doc(ctx.db, `families/${ctx.state.claims.fid}/players/${ctx.currentPlayer().id}/checklist/state`);
}

export function bindChecklist(ctx) {
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.toggle; const on = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on);
    try { await updateDoc(stateRef(ctx), { [`done.${id}`]: on ? serverTimestamp() : deleteField() }); } catch (e) {
      ctx.setUi('planMsg', { text: errorText(e, 'Could not save that change.'), bad: true });
    }
  }));
  document.querySelectorAll('[data-skip]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.skip; const skipped = ctx.state.checklist?.skipped?.[id];
    await updateDoc(stateRef(ctx), { [`skipped.${id}`]: skipped ? deleteField() : serverTimestamp() })
      .catch((e) => ctx.setUi('planMsg', { text: errorText(e), bad: true }));
  }));
}

export default {
  tab: 'home',
  render(ctx) {
    const p = ctx.currentPlayer();
    if (!p) { ctx.navigate('#/home'); return ''; }
    if (!ctx.state.template || !ctx.state.checklist) return '<p class="muted" role="status">Loading your plan…</p>';
    const plan = buildPlan(ctx.state.template, p, ctx.state.checklist);
    const groups = new Map();
    for (const i of plan.items) {
      const key = i.custom ? 'Your tasks' : gradeLabel(i.grade);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    const msg = ctx.state.ui.planMsg;
    return `${playerSwitcher(ctx)}<a class="back" href="#/home">← Home</a>
      <h1>${esc(p.firstName)}’s plan</h1>
      <p class="muted">${plan.items.length} steps from now to commitment, built around Sept 1, ${p.gradYear - 2}.</p>
      ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
      ${[...groups].map(([name, items]) => `<section class="card"><h2>${esc(name)}</h2>
        <div class="list">${items.map((i) => checklistItemHtml(i, ctx, { showSkip: true })).join('')}</div></section>`).join('')}
      ${ctx.can('save') ? `<form id="custom-task" class="card">
        <h2>Add your own task</h2>
        <div class="field"><label for="ct-title">Task</label><input id="ct-title" name="title" maxlength="120" required placeholder="Call Coach Reyes back"></div>
        <div class="field"><label for="ct-due">Due</label><input id="ct-due" name="due" type="date" required></div>
        <button class="btn btn-dark" type="submit">Add task</button>
      </form>` : ''}`;
  },
  bind(ctx) {
    bindSwitcher(ctx); bindChecklist(ctx);
    $('custom-task')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { title, due } = formToObject(e.target);
      if (!title || !due) { ctx.setUi('planMsg', { text: 'Enter a task and a due date.', bad: true }); return; }
      const id = `c${Date.now().toString(36)}`;
      try {
        await updateDoc(stateRef(ctx), { [`custom.${id}`]: { title: title.slice(0, 120), due } });
        ctx.setUi('planMsg', { text: 'Task added.' });
      } catch (err) { ctx.setUi('planMsg', { text: errorText(err), bad: true }); }
    });
  },
};
