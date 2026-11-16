// Recruiting spend (#/spend): every dollar in one total. Add (#/spend/add), edit (#/spend/<id>),
// scan a receipt, budget, per-player view and CSV export.
import {
  doc, collection, addDoc, updateDoc, deleteDoc, setDoc, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { ref as sref, uploadBytes } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import { storage } from '../firebase.js';
import { $, esc, options, formToObject, fmtDay, errorText, money } from '../util.js';
import { CATEGORIES, categoryLabel, totals, toCents, toCsv, expenseSeason } from '../lib/expenses.js';
import { seasonKey } from '../lib/plan.js';

const SOURCE = { plan: 'From your summer plan', laxhq: 'Added automatically', partner: 'Added by the reel partner', receipt: 'Scanned receipt', manual: '' };

let unsub = null; let budgetUnsub = null; let watching = null;
function watch(ctx) {
  const fid = ctx.state.claims.fid;
  const season = ctx.state.ui.season || seasonKey(new Date());
  const k = `${fid}/${season}`;
  if (watching === k) return;
  stopSpendWatch(); watching = k;
  unsub = onSnapshot(collection(ctx.db, `families/${fid}/expenses`), (s) => {
    ctx.state.expenses = s.docs.map((d) => ({ id: d.id, ...d.data() })); ctx.rerender();
  }, (e) => console.error('expenses', e));
  budgetUnsub = onSnapshot(doc(ctx.db, `families/${fid}/budgets/${season}`), (d) => {
    ctx.state.budget = d.exists() ? d.data() : null; ctx.rerender();
  }, (e) => console.error('budget', e));
}
export function stopSpendWatch() { unsub?.(); budgetUnsub?.(); unsub = null; budgetUnsub = null; watching = null; }

function seasons(expenses) {
  const set = new Set([seasonKey(new Date()), ...expenses.map(expenseSeason)]);
  return [...set].sort().reverse();
}

function mainView(ctx) {
  const s = ctx.state;
  if (!s.expenses) return '<p class="muted" role="status">Loading…</p>';
  const season = s.ui.season || seasonKey(new Date());
  const who = s.ui.spendPlayer || '';
  const t = totals(s.expenses, { season, playerId: who || null, familyPlayerCount: s.players.length || 1 });
  const max = Math.max(1, ...t.byCategory.map((c) => c.cents));
  const budget = s.budget?.totalCents || null;
  const msg = s.ui.spendMsg;
  return `<a class="back" href="#/events">← Summer plan</a>
    <div class="row"><h1>Recruiting spend</h1><a class="btn btn-primary btn-sm" href="#/spend/add">Add expense</a></div>
    ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
    <div class="two">
      <div class="field"><label for="sp-season">Season (Sept–Aug)</label><select id="sp-season">${options(seasons(s.expenses), season)}</select></div>
      <div class="field"><label for="sp-player">Player</label><select id="sp-player">${options([{ value: '', label: 'Whole family' }, ...s.players.map((p) => ({ value: p.id, label: p.firstName }))], who)}</select></div>
    </div>
    <div class="card dark" id="spend-total">
      <span class="small caps">Spent this season</span>
      <span class="big">${money(t.spentCents)}</span>
      <div class="row small"><span>+ ${money(t.plannedCents)} planned</span><b style="color:#fff">${money(t.projectedCents)} projected</b></div>
      ${budget ? `<div class="bar" role="img" aria-label="${Math.round((t.projectedCents / budget) * 100)}% of budget"><i style="width:${Math.min(100, Math.round((t.projectedCents / budget) * 100))}%"></i></div>
        <span class="small">${t.projectedCents > budget ? `${money(t.projectedCents - budget)} over` : `${money(budget - t.projectedCents)} under`} your ${money(budget)} budget</span>` : ''}
    </div>
    ${t.byCategory.length ? `<section class="card"><h2>By category</h2>${t.byCategory.map((c) => `<div class="catrow"><div class="row"><span>${esc(c.label)}</span><b>${money(c.cents)}</b></div><div class="meter"><i style="width:${Math.round((c.cents / max) * 100)}%"></i></div></div>`).join('')}</section>` : ''}
    ${t.byMonth.length > 1 ? `<section class="card"><h2>By month</h2><div class="months">${t.byMonth.map((m) => `<div><span class="small">${new Date(`${m.month}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short' })}</span><b>${money(m.cents)}</b></div>`).join('')}</div></section>` : ''}
    <section class="card"><h2>Expenses</h2>
      ${t.items.length ? `<div class="list">${t.items.map((e) => `<div><a class="grow plain" href="#/spend/${esc(e.id)}"><b>${esc(e.payee || categoryLabel(e.category))}</b><br>
        <span class="small">${esc(categoryLabel(e.category))} · ${fmtDay(new Date(`${e.date}T12:00:00`))}${e.status === 'planned' ? ' · planned' : ''}${SOURCE[e.source] ? ` · ${SOURCE[e.source]}` : ''}</span></a>
        <b class="${e.status === 'planned' ? 'muted' : ''}">${money(e.share)}</b></div>`).join('')}</div>`
    : '<p class="muted">Nothing yet this season. Add club dues, tournament fees, hotels and travel as they happen, or scan a receipt.</p>'}
    </section>
    <form id="budget-form" class="card" novalidate>
      <h2>Season budget</h2>
      <div class="copy"><input id="budget" name="budget" inputmode="decimal" placeholder="e.g. 8000" value="${budget ? budget / 100 : ''}" aria-label="Season budget in dollars"><button class="btn btn-ghost" type="submit">Save</button></div>
    </form>
    <button class="btn btn-ghost" id="export-csv">Download spreadsheet (CSV)</button>
    <p class="small">For your records. LaxHQ doesn’t give tax advice.</p>`;
}

function formView(ctx, ex = null) {
  const s = ctx.state;
  const ui = s.ui;
  const pre = ui.scan || {};
  const v = ex || { date: pre.date || new Date().toISOString().slice(0, 10), category: pre.category || 'tournaments', payee: pre.payee || '', amount: pre.amount || '' };
  const locked = ex && ['plan', 'laxhq', 'partner'].includes(ex.source);
  const msg = ui.expMsg;
  const ids = ex ? ex.playerIds || [] : (s.players.length === 1 ? [s.players[0].id] : [ctx.currentPlayer()?.id].filter(Boolean));
  return `<a class="back" href="#/spend">← Recruiting spend</a><h1>${ex ? 'Expense' : 'Add an expense'}</h1>
    ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
    ${locked ? `<div class="banner info">${esc(SOURCE[ex.source])}. ${ex.source === 'plan' ? 'Change it on the event in your summer plan.' : 'It can’t be edited here.'}</div>` : ''}
    ${!ex ? `<section class="card"><h2>Scan a receipt</h2><p class="small">Take a photo or pick a file; LaxHQ fills in the form for you to check.</p>
      <label class="btn btn-dark" for="receipt-file">${ui.scanning ? 'Reading…' : 'Choose photo or PDF'}</label>
      <input id="receipt-file" type="file" accept="image/*,application/pdf" capture="environment" class="sr-only"></section>` : ''}
    <form id="expense-form" class="card" novalidate>
      <div class="two">
        <div class="field"><label for="ex-amount">Amount ($)</label><input id="ex-amount" name="amount" inputmode="decimal" value="${esc(ex ? (ex.amountCents / 100).toFixed(2) : v.amount)}" ${locked ? 'disabled' : ''} required></div>
        <div class="field"><label for="ex-date">Date</label><input id="ex-date" name="date" type="date" value="${esc(v.date)}" ${locked ? 'disabled' : ''} required></div>
      </div>
      <div class="field"><label for="ex-cat">Category</label><select id="ex-cat" name="category" ${locked ? 'disabled' : ''}>${options(CATEGORIES, v.category)}</select></div>
      <div class="field"><label for="ex-payee">Paid to</label><input id="ex-payee" name="payee" maxlength="100" value="${esc(v.payee)}" ${locked ? 'disabled' : ''}></div>
      ${s.players.length > 1 ? `<fieldset class="field"><legend class="label">For</legend><div class="checks">${s.players.map((p) => `<label class="check"><input type="checkbox" name="playerIds[]" value="${esc(p.id)}"${ids.includes(p.id) ? ' checked' : ''} ${locked ? 'disabled' : ''}> ${esc(p.firstName)}</label>`).join('')}</div>
        <p class="small">Pick more than one to split a shared cost. Pick none for a family-wide cost.</p></fieldset>` : ''}
      <label class="check" style="align-self:flex-start"><input type="checkbox" name="planned" ${ex?.status === 'planned' ? 'checked' : ''} ${locked ? 'disabled' : ''}> Not paid yet (planned)</label>
      <div class="field"><label for="ex-note">Note</label><input id="ex-note" name="note" maxlength="200" value="${esc(ex?.note || '')}" ${locked ? 'disabled' : ''}></div>
      ${locked ? '' : `<button class="btn btn-primary" type="submit">${ex ? 'Save' : 'Add expense'}</button>`}
    </form>
    ${ex && !locked ? '<button class="btn btn-ghost" id="delete-expense">Delete expense</button>' : ''}`;
}

function download(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default {
  tab: 'events',
  render(ctx, args) {
    if (!ctx.isPro()) { ctx.navigate('#/events'); return ''; }
    watch(ctx);
    if (args[0] === 'add') return formView(ctx);
    if (args[0]) {
      if (!ctx.state.expenses) return '<p class="muted" role="status">Loading…</p>';
      const ex = ctx.state.expenses.find((e) => e.id === decodeURIComponent(args[0]));
      return ex ? formView(ctx, ex) : '<a class="back" href="#/spend">← Recruiting spend</a><p class="muted">That expense was not found.</p>';
    }
    return mainView(ctx);
  },
  bind(ctx, args) {
    const s = ctx.state; const fid = s.claims.fid;
    $('sp-season')?.addEventListener('change', (e) => { s.ui.season = e.target.value; stopSpendWatch(); ctx.rerender(); });
    $('sp-player')?.addEventListener('change', (e) => ctx.setUi('spendPlayer', e.target.value));
    $('budget-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = $('budget').value.trim();
      const cents = v ? toCents(v) : null;
      if (v && !cents) { ctx.setUi('spendMsg', { text: 'Enter the budget in dollars.', bad: true }); return; }
      try {
        await setDoc(doc(ctx.db, `families/${fid}/budgets/${s.ui.season || seasonKey(new Date())}`), { totalCents: cents, updatedAt: serverTimestamp() }, { merge: true });
        ctx.setUi('spendMsg', { text: 'Budget saved.' });
      } catch (err) { ctx.setUi('spendMsg', { text: errorText(err), bad: true }); }
    });
    $('export-csv')?.addEventListener('click', () => download(`laxhq-spend-${s.ui.season || seasonKey(new Date())}.csv`,
      toCsv(s.expenses.filter((e) => expenseSeason(e) === (s.ui.season || seasonKey(new Date()))), s.players)));

    $('receipt-file')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { ctx.setUi('expMsg', { text: 'That file is over 10 MB.', bad: true }); return; }
      s.ui.scanning = true; ctx.setUi('expMsg', { text: 'Reading your receipt…' });
      try {
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
        const path = `receipts/${fid}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await uploadBytes(sref(storage, path), file, { contentType: file.type || 'image/jpeg' });
        const res = await ctx.call('scanReceipt', { path });
        s.ui.scanning = false; s.ui.scan = { ...res, path };
        ctx.setUi('expMsg', { text: res.amount ? 'Check the details, then add it.' : 'Couldn’t read every detail. Fill in the rest.' });
      } catch (err) { s.ui.scanning = false; ctx.setUi('expMsg', { text: errorText(err), bad: true }); }
    });

    $('expense-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formToObject(e.target);
      const cents = toCents(d.amount);
      if (!cents) { ctx.setUi('expMsg', { text: 'Enter the amount in dollars, like 412.36.', bad: true }); return; }
      if (!d.date) { ctx.setUi('expMsg', { text: 'Choose the date.', bad: true }); return; }
      const playerIds = s.players.length > 1 ? (d.playerIds || []) : s.players.map((p) => p.id);
      const data = {
        amountCents: cents, date: d.date, season: seasonKey(new Date(`${d.date}T12:00:00`)), category: d.category,
        payee: d.payee ? d.payee.slice(0, 100) : null, note: d.note ? d.note.slice(0, 200) : null, playerIds,
        status: d.planned ? 'planned' : 'spent', updatedAt: serverTimestamp(),
      };
      try {
        if (args[0] && args[0] !== 'add') await updateDoc(doc(ctx.db, `families/${fid}/expenses/${decodeURIComponent(args[0])}`), data);
        else {
          await addDoc(collection(ctx.db, `families/${fid}/expenses`), {
            ...data, source: s.ui.scan ? 'receipt' : 'manual', receiptPath: s.ui.scan?.path || null, createdBy: s.user.uid, createdAt: serverTimestamp(),
          });
        }
        ctx.navigate('#/spend', { spendMsg: { text: 'Saved.' }, season: s.ui.season, spendPlayer: s.ui.spendPlayer });
      } catch (err) { ctx.setUi('expMsg', { text: errorText(err), bad: true }); }
    });
    $('delete-expense')?.addEventListener('click', async () => {
      if (!confirm('Delete this expense?')) return;
      try { await deleteDoc(doc(ctx.db, `families/${fid}/expenses/${decodeURIComponent(args[0])}`)); ctx.navigate('#/spend'); } catch (err) { ctx.setUi('expMsg', { text: errorText(err), bad: true }); }
    });
  },
};
