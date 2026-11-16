// Phase 7 scenario: help and legal pages, and deleting a family from the Profile tab.
import assert from 'node:assert/strict';
import { BASE, launch, proFamilyWithPlayer, admin, uidFor } from './helpers.mjs';

const db = admin();
const run = await launch();
try {
  const page = await run.page('account');
  for (const [path, heading] of [['help.html', 'Help'], ['privacy.html', 'Privacy Policy'], ['terms.html', 'Terms of Service']]) {
    await page.goto(`${BASE}${path}`);
    await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
  }
  await page.goto(BASE);
  await page.locator('#signin .links a[href="/privacy.html"]').waitFor();

  await proFamilyWithPlayer(page, 'quinn@example.com', 'Quinn Hale', { first: 'Ben', last: 'Hale', grad: '2030', pos: 'goalie' });
  const uid = await uidFor('quinn@example.com');
  const fid = (await db.doc(`users/${uid}`).get()).get('familyId');

  await page.goto(`${BASE}#/profile`);
  await page.locator('#danger').waitFor();
  page.promptAnswer = 'nope';
  await page.click('[data-delete="family"]');
  await page.getByText('Nothing was deleted.').waitFor();
  page.promptAnswer = 'DELETE';
  await page.click('[data-delete="family"]');
  await page.locator('#signin').waitFor({ state: 'visible', timeout: 20000 });
  assert.equal((await db.doc(`families/${fid}`).get()).exists, false);
  assert.equal(await uidFor('quinn@example.com'), undefined, 'login removed');

  assert.deepEqual(run.errors, [], run.errors.join('; '));
  console.log('e2e account: help, privacy and terms pages, delete family from Profile ✔');
} finally {
  await run.close();
}
