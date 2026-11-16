// Expense tracker math: totals by season, category, month and player; CSV export. Pure; unit tested.
import { seasonKey } from './plan.js';

export const CATEGORIES = [
  { value: 'club_dues', label: 'Club dues' },
  { value: 'tournaments', label: 'Tournaments & showcases' },
  { value: 'camps', label: 'College camps & prospect days' },
  { value: 'travel', label: 'Travel (gas, flights)' },
  { value: 'hotels', label: 'Hotels' },
  { value: 'meals', label: 'Meals' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'highlights', label: 'Highlight reels' },
  { value: 'services', label: 'Recruiting services (LaxHQ, other platforms)' },
  { value: 'training', label: 'Private training' },
  { value: 'testing', label: 'Test prep & applications' },
  { value: 'other', label: 'Other' },
];
export const categoryLabel = (v) => CATEGORIES.find((c) => c.value === v)?.label || 'Other';

/** "1,150.50" / "$412" / "412" → cents. Returns null when it isn't a positive amount. */
export function toCents(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? Math.round(input * 100) : null;
  const s = String(input ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents > 0 ? cents : null;
}

/** Season of an expense from its yyyy-mm-dd date. */
export const expenseSeason = (e) => e.season || seasonKey(new Date(`${e.date}T12:00:00`));

/**
 * The share of one expense that belongs to a player. Shared costs split evenly; an expense with
 * no players listed is family-wide and splits across all of the family's players.
 */
export function playerShare(e, playerId, familyPlayerCount = 1) {
  const ids = e.playerIds || [];
  if (!playerId) return e.amountCents;
  if (!ids.length) return Math.round(e.amountCents / Math.max(familyPlayerCount, 1));
  return ids.includes(playerId) ? Math.round(e.amountCents / ids.length) : 0;
}

/**
 * Totals for a season (or all time when season is null), optionally for one player.
 * @returns {{ spentCents, plannedCents, projectedCents, byCategory: {category, label, cents}[],
 *            byMonth: {month, cents}[], items: object[] }}
 */
export function totals(expenses, { season = null, playerId = null, familyPlayerCount = 1 } = {}) {
  const items = expenses
    .filter((e) => !season || expenseSeason(e) === season)
    .map((e) => ({ ...e, share: playerShare(e, playerId, familyPlayerCount) }))
    .filter((e) => e.share > 0);
  let spent = 0; let planned = 0;
  const cat = new Map(); const month = new Map();
  for (const e of items) {
    if (e.status === 'planned') { planned += e.share; continue; }
    spent += e.share;
    cat.set(e.category, (cat.get(e.category) || 0) + e.share);
    const m = String(e.date).slice(0, 7);
    month.set(m, (month.get(m) || 0) + e.share);
  }
  return {
    spentCents: spent,
    plannedCents: planned,
    projectedCents: spent + planned,
    byCategory: [...cat].map(([category, cents]) => ({ category, label: categoryLabel(category), cents })).sort((a, b) => b.cents - a.cents),
    byMonth: [...month].map(([m, cents]) => ({ month: m, cents })).sort((a, b) => a.month.localeCompare(b.month)),
    items: items.sort((a, b) => String(b.date).localeCompare(String(a.date))),
  };
}

/** Spreadsheet export. Amounts in dollars; one row per expense. */
export function toCsv(expenses, players = []) {
  const name = (id) => players.find((p) => p.id === id)?.firstName || id;
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
  };
  const rows = [['Date', 'Season', 'Category', 'Payee', 'Player(s)', 'Status', 'Amount (USD)', 'Note', 'Source']];
  for (const e of [...expenses].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    rows.push([e.date, expenseSeason(e), categoryLabel(e.category), e.payee, (e.playerIds || []).map(name).join(' + ') || 'Family',
      e.status === 'planned' ? 'Planned' : 'Spent', (e.amountCents / 100).toFixed(2), e.note, e.source]);
  }
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
