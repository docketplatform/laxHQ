// Admin area and highlight reels: the owner sees every family, sets up the reel partner,
// a family requests a reel from the Highlights tab, and the owner sees the request.
import assert from 'node:assert/strict';
import { BASE, launch, proFamilyWithPlayer, admin, uidFor } from './helpers.mjs';

const db = admin();
const run = await launch();
try {
  await db.doc('config/highlights').delete();
  const fam = await run.page('family');
  await proFamilyWithPlayer(fam, 'mshaw@example.com', 'Riley Shaw', { first: 'Mia', last: 'Shaw', grad: '2029', pos: 'midfield', club: 'Mesa Lax' });

  // Not an admin: no Admin link, and the area is closed.
  await fam.goto(`${BASE}#/admin`);
  await fam.getByText('This area is for the LaxHQ team.').waitFor();
  assert.equal(await fam.locator('#admin-link').isVisible(), false);

  // Before a partner is set up, Highlights says so.
  await fam.goto(`${BASE}#/highlights`);
  await fam.getByText('Coaches watch film first').waitFor();

  const owner = await run.page('owner');
  await proFamilyWithPlayer(owner, 'olive.owner@example.com', 'Olive Owner', { first: 'Sam', last: 'Owner', grad: '2030', pos: 'attack' });
  await db.doc(`admins/${await uidFor('olive.owner@example.com')}`).set({ email: 'olive.owner@example.com' });
  await owner.reload();
  await owner.locator('#admin-link').click();
  await owner.locator('.admin-fam', { hasText: 'Mia Shaw' }).waitFor({ timeout: 15000 });
  assert.match(await owner.locator('.admin-fam', { hasText: 'Mia Shaw' }).innerText(), /mshaw@example\.com/);
  await owner.fill('#admin-q', 'Mesa');
  await owner.waitForFunction(() => document.querySelectorAll('.admin-fam').length === 1);
  assert.match(await owner.locator('.admin-fam').innerText(), /Mia Shaw/);

  // Set up the partner.
  await owner.click('[data-go="#/admin/partner"]');
  await owner.check('#partner-form input[name=active]');
  await owner.fill('#pt-name', 'Dan Reyes');
  await owner.fill('#pt-business', 'Reyes Film Co.');
  await owner.fill('#pt-email', 'dan@example.com');
  await owner.fill('#pt-priceFrom', 'From $250');
  await owner.fill('#pt-includes', 'Full-game breakdown\nCoach-ready intro slate');
  await owner.click('#partner-form button[type=submit]');
  await owner.getByText('Families now see this partner').waitFor();

  // The family requests a reel.
  await fam.goto(`${BASE}#/home`);
  await fam.locator('#reel-promo').click();
  await fam.locator('#hl-partner', { hasText: 'Reyes Film Co.' }).waitFor({ timeout: 15000 });
  assert.match(await fam.locator('#hl-partner').innerText(), /From \$250[\s\S]*Coach-ready intro slate/);
  await fam.fill('#hl-film', 'https://www.hudl.com/video/1');
  await fam.fill('#hl-when', 'Before June');
  await fam.click('#hl-form button[type=submit]');
  await fam.locator('#hl-sent').waitFor();
  await fam.locator('#hl-mine', { hasText: 'Mia Shaw' }).waitFor();

  // The owner sees it and marks it booked.
  await owner.click('#admin-refresh');
  await owner.click('[data-go="#/admin/requests"]');
  await owner.locator('.card', { hasText: 'Before June' }).waitFor({ timeout: 15000 });
  await owner.selectOption('[data-req]', 'booked');
  for (let i = 0; i < 50; i += 1) {
    if ((await db.collection('highlightRequests').get()).docs[0]?.get('status') === 'booked') break;
    await fam.waitForTimeout(200);
  }
  assert.equal((await db.collection('highlightRequests').get()).docs[0].get('status'), 'booked');

  assert.deepEqual(run.errors, [], run.errors.join('; '));
  console.log('e2e admin: families list, search, partner setup, reel request, request status ✔');
} finally {
  await run.close();
}
