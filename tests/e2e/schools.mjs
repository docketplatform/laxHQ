// Phase 2 scenario: build a school list, see fit and "How you compare", override, notes, remove.
import assert from 'node:assert/strict';
import { BASE, SHOTS, launch, proFamilyWithPlayer, setPlan, admin, uidFor } from './helpers.mjs';

const db = admin();
await db.doc('schools/lafayette-college').set({ academics: { avgHsGpa: 3.6, admitRate: 0.3, sat25: 1250, sat75: 1420 } }, { merge: true });

const run = await launch();
try {
  const page = await run.page('schools');
  await proFamilyWithPlayer(page, 'casey@example.com', 'Casey Lee', {
    first: 'Max', last: 'Lee', grad: '2029', pos: 'midfield', hs: 'Annapolis HS', state: 'MD', gpa: '3.7', club: 'Chesapeake Elite', level: 'national',
  });

  await page.goto(`${BASE}#/schools`);
  await page.getByText('Start your list').waitFor();
  await page.click('text=Add your first school');
  await page.locator('#results').waitFor({ timeout: 15000 });

  await page.fill('#school-q', 'lafay');
  await page.locator('[data-add="lafayette-college"]').click();
  await page.getByText('Lafayette College added.').waitFor();
  await page.fill('#school-q', 'tufts');
  await page.locator('[data-add="tufts-university"]').click();
  await page.getByText('Tufts University added.').waitFor();
  // Division filter hides D3 schools.
  await page.fill('#school-q', '');
  await page.selectOption('#school-div', 'D1');
  assert.equal(await page.locator('#results >> text=Tufts University').count(), 0);
  // Women's-only programs don't appear for a boys' player.
  await page.selectOption('#school-div', '');
  await page.fill('#school-q', 'northwestern');
  await page.getByText('No schools match').waitFor();

  await page.fill('#cs-name', 'Roanoke College');
  await page.selectOption('#cs-div', 'D3');
  await page.selectOption('#cs-state', 'VA');
  await page.fill('#cs-conf', 'ODAC');
  await page.click('#custom-school button[type=submit]');
  await page.getByText('Roanoke College added.').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/6-add-school.png`, fullPage: true });

  await page.goto(`${BASE}#/schools`);
  await page.locator('#balance').waitFor();
  assert.equal(await page.locator('a.link-card').count(), 3);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/7-schools.png`, fullPage: true });

  // Detail: Patriot League tier 3 vs national club → athletic Target; GPA 3.7 vs 3.6 → academic Target.
  await page.click('text=Lafayette College');
  await page.getByRole('heading', { name: 'How you compare' }).waitFor();
  const fit = await page.locator('#fit .fits').innerText();
  assert.match(fit, /Athletic\s+Target/);
  assert.match(fit, /Academic\s+Target/);
  const cmp = await page.locator('#compare').innerText();
  assert.match(cmp, /average GPA\s+3\.6/);
  assert.match(cmp, /1250–1420/);
  assert.match(cmp, /bar for recruited athletes can differ/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/8-school-detail.png`, fullPage: true });

  await page.selectOption('#tier-override', 'reach');
  await page.getByText('Saved.').waitFor();
  await page.selectOption('#t-status', 'contacted');
  await page.fill('#t-notes', 'Coach liked the fall film.');
  await page.click('#target-form button[type=submit]');
  await page.locator('#view >> text=Saved.').waitFor();

  await page.goto(`${BASE}#/schools`);
  const lafayette = page.locator('a.link-card', { hasText: 'Lafayette College' });
  await lafayette.locator('.chip', { hasText: 'Reach' }).waitFor();
  assert.match(await lafayette.innerText(), /Contacted/);

  // Remove the custom school; the counter follows.
  await page.click('text=Roanoke College');
  await page.click('#remove-target');
  await page.locator('a.link-card').nth(1).waitFor();
  assert.equal(await page.locator('a.link-card').count(), 2);
  const fid = (await db.doc(`users/${await uidFor('casey@example.com')}`).get()).get('familyId');
  const players = await db.collection(`families/${fid}/players`).get();
  assert.equal(players.docs[0].get('targetCount'), 2);

  // Back on Free, the Schools tab is the sample again and nothing can be added.
  await setPlan(page, 'free');
  await page.goto(`${BASE}#/schools`);
  await page.getByText('You’re looking at a sample family.').waitFor();

  assert.deepEqual(run.errors, [], run.errors.join('; '));
  console.log('e2e schools: catalog search, custom school, fit, how you compare, override, notes, remove ✔');
} finally {
  await run.close();
}
