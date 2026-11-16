// Phase 5 scenario: connect a club calendar, plan summer events, see clashes, track spending.
import assert from 'node:assert/strict';
import { BASE, SHOTS, launch, proFamilyWithPlayer } from './helpers.mjs';
import { startMockAnthropic } from '../mock-anthropic.mjs';
import { startFeedServer, ics } from '../feed-server.mjs';

const Y = new Date().getFullYear() + 1;
const feeds = await startFeedServer({
  '/club.ics': ics([
    { uid: 'e2e-g1', date: `${Y}-07-25`, time: '1300', title: 'Game vs Express', cal: 'Long Island Express 2029' },
    { uid: 'e2e-g2', date: `${Y}-06-12`, title: 'Practice', cal: 'Long Island Express 2029' },
    { uid: 'e2e-s1', date: `${Y}-07-25`, title: 'U10 Soccer', cal: 'Sam - U10 Soccer' },
  ], 'Riley family'),
});
const mock = await startMockAnthropic(() => ({ json: { amount: '412.36', date: `${Y - 1}-11-08`, payee: 'Hampton Inn', category: 'hotels' } }));
const run = await launch();
try {
  const page = await run.page('events');
  await proFamilyWithPlayer(page, 'taylor@example.com', 'Taylor Riley', {
    first: 'Cole', last: 'Riley', grad: '2029', pos: 'defense', club: 'Long Island Express',
  });

  // Connect the club calendar; keep only the lacrosse calendar.
  await page.goto(`${BASE}#/events`);
  await page.getByRole('heading', { name: 'Plan your summer' }).waitFor();
  await page.goto(`${BASE}#/events/club`);
  await page.fill('#club-url', feeds.url('/club.ics'));
  await page.click('#club-form button[type=submit]');
  await page.getByText('Which calendars are lacrosse?').waitFor({ timeout: 20000 });
  await page.check('input[name=cal][value="Long Island Express 2029"]');
  await page.uncheck('input[name=cal][value="Sam - U10 Soccer"]');
  await page.click('#cal-form button[type=submit]');
  await page.getByText('Connected Long Island Express 2029: 2 events.').waitFor({ timeout: 20000 });
  await page.locator('#club', { hasText: '2 events · synced' }).waitFor();

  // A summer event that clashes with a club game.
  await page.click('text=Add event');
  await page.fill('#ev-title', 'Northeast Elite Weekend');
  await page.selectOption('#ev-status', 'registered');
  await page.fill('#ev-start', `${Y}-07-24`);
  await page.fill('#ev-end', `${Y}-07-26`);
  await page.fill('#ev-city', 'Newport');
  await page.selectOption('#ev-state', 'RI');
  await page.fill('#ev-cost', '1400');
  await page.fill('#ev-nights', '3');
  await page.click('#event-form button[type=submit]');
  await page.locator('.conflict', { hasText: 'Northeast Elite Weekend overlaps Long Island Express 2029: Game vs Express on Jul 25' }).waitFor({ timeout: 20000 });
  assert.match(await page.locator('.tri').innerText(), /1\s*Events[\s\S]*1\s*Conflicts[\s\S]*\$1,400\s*Planned cost/);
  assert.doesNotMatch(await page.locator('#view').innerText(), /U10 Soccer/, 'the sibling’s soccer never imports');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/13-events.png`, fullPage: true });
  await page.goto(`${BASE}#/home`);
  await page.locator('#alerts', { hasText: 'overlaps' }).waitFor();

  // Spending: the planned event cost is already there; add dues by hand.
  await page.goto(`${BASE}#/spend`);
  await page.locator('#spend-total', { hasText: '$1,400 planned' }).waitFor({ timeout: 15000 });
  await page.click('text=Add expense');
  await page.fill('#ex-amount', '800');
  await page.fill('#ex-date', `${Y - 1}-11-01`);
  await page.selectOption('#ex-cat', 'club_dues');
  await page.fill('#ex-payee', 'Long Island Express');
  await page.click('#expense-form button[type=submit]');
  await page.locator('#spend-total', { hasText: '$800' }).waitFor();

  // Scan a receipt: the form fills in from the photo.
  await page.click('text=Add expense');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#receipt-file', { name: 'hotel.png', mimeType: 'image/png', buffer: png });
  await page.getByText('Check the details, then add it.').waitFor({ timeout: 20000 });
  assert.equal(await page.inputValue('#ex-amount'), '412.36');
  assert.equal(await page.inputValue('#ex-payee'), 'Hampton Inn');
  assert.equal(await page.inputValue('#ex-cat'), 'hotels');
  await page.click('#expense-form button[type=submit]');
  await page.locator('#spend-total', { hasText: '$1,212' }).waitFor();
  await page.fill('#budget', '5000');
  await page.click('#budget-form button[type=submit]');
  await page.locator('#spend-total', { hasText: 'under your $5,000 budget' }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/14-spend.png`, fullPage: true });

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
  const csv = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  assert.match(csv, /Date,Season,Category,Payee/);
  assert.match(csv, /Hampton Inn/);
  assert.match(csv, /Long Island Express/);

  // Mark the event attended with what it really cost: it moves from planned to spent.
  await page.goto(`${BASE}#/events`);
  await page.click('text=Northeast Elite Weekend');
  await page.selectOption('#ev-status', 'attended');
  await page.fill('#ev-actual', '1250');
  await page.click('#event-form button[type=submit]');
  await page.getByText('Saved. LaxHQ is checking it').waitFor();
  assert.match(await page.locator('a.link-card', { hasText: 'Northeast Elite Weekend' }).innerText(), /Attended · \$1,250/);
  await page.goto(`${BASE}#/spend`);
  await page.selectOption('#sp-season', `${Y - 1}-${String(Y % 100).padStart(2, '0')}`);
  await page.locator('#spend-total', { hasText: '$0 planned' }).waitFor({ timeout: 15000 });
  assert.match(await page.locator('#spend-total').innerText(), /\$2,462/);

  assert.deepEqual(run.errors, [], run.errors.join('; '));
  console.log('e2e events: club calendar, calendar picking, clash alert, planned cost, manual + scanned expenses, budget, CSV, attended ✔');
} finally {
  await run.close();
  await mock.close();
  await feeds.close();
}
