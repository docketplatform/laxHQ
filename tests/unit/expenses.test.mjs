import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, totals, playerShare, toCsv, expenseSeason } from '../../web/lib/expenses.js';

const E = [
  { id: 'a', date: '2026-11-01', category: 'club_dues', amountCents: 80000, status: 'spent', playerIds: ['jake'], payee: 'Chesapeake Elite' },
  { id: 'b', date: '2026-11-08', category: 'hotels', amountCents: 41200, status: 'spent', playerIds: ['jake', 'sam'], payee: 'Hampton Inn' },
  { id: 'c', date: '2026-10-14', category: 'services', amountCents: 50000, status: 'spent', playerIds: [], payee: 'LaxHQ', source: 'laxhq' },
  { id: 'd', date: '2027-06-19', category: 'tournaments', amountCents: 115000, status: 'planned', playerIds: ['jake'], payee: 'Mid-Atlantic Showcase' },
  { id: 'e', date: '2026-08-20', category: 'camps', amountCents: 31000, status: 'spent', playerIds: ['jake'] },
];

test('amounts parse to cents', () => {
  assert.equal(toCents('1,150.50'), 115050);
  assert.equal(toCents('$412'), 41200);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents('0'), null);
  assert.equal(toCents('-5'), null);
  assert.equal(toCents('12.345'), null);
  assert.equal(toCents('abc'), null);
});

test('seasons run Sept 1 – Aug 31', () => {
  assert.equal(expenseSeason({ date: '2026-08-31' }), '2025-26');
  assert.equal(expenseSeason({ date: '2026-09-01' }), '2026-27');
});

test('season totals: spent, planned, projected, by category and month', () => {
  const t = totals(E, { season: '2026-27' });
  assert.equal(t.spentCents, 80000 + 41200 + 50000);
  assert.equal(t.plannedCents, 115000);
  assert.equal(t.projectedCents, 286200);
  assert.deepEqual(t.byCategory.map((c) => c.category), ['club_dues', 'services', 'hotels']);
  assert.deepEqual(t.byMonth, [{ month: '2026-10', cents: 50000 }, { month: '2026-11', cents: 121200 }]);
  assert.equal(t.items[0].id, 'd', 'newest first');
});

test('per-player totals split shared and family-wide costs', () => {
  assert.equal(playerShare(E[1], 'jake'), 20600);
  assert.equal(playerShare(E[1], 'other'), 0);
  assert.equal(playerShare(E[2], 'sam', 2), 25000);
  const jake = totals(E, { season: '2026-27', playerId: 'jake', familyPlayerCount: 2 });
  assert.equal(jake.spentCents, 80000 + 20600 + 25000);
  const sam = totals(E, { season: '2026-27', playerId: 'sam', familyPlayerCount: 2 });
  assert.equal(sam.spentCents, 20600 + 25000);
  assert.equal(sam.plannedCents, 0);
});

test('CSV export: one row per expense, escaped, formula-safe', () => {
  const csv = toCsv([...E, { date: '2026-12-01', category: 'other', amountCents: 500, status: 'spent', payee: '=HYPERLINK("x")', note: 'a, "b"' }],
    [{ id: 'jake', firstName: 'Jake' }, { id: 'sam', firstName: 'Sam' }]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Date,Season,Category,Payee,Player(s),Status,Amount (USD),Note,Source');
  assert.equal(lines.length, 7);
  assert.match(csv, /2026-11-08,2026-27,Hotels,Hampton Inn,Jake \+ Sam,Spent,412\.00/);
  assert.match(csv, /LaxHQ,Family,Spent,500\.00/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"a, ""b"""/);
});
