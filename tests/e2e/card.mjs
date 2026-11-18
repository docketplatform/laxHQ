// Phase 3 scenario: publish the recruiting card, a coach opens it, the family sees the view.
import assert from 'node:assert/strict';
import { BASE, SHOTS, launch, proFamilyWithPlayer, DESKTOP_CHROME } from './helpers.mjs';

const run = await launch();
try {
  const page = await run.page('family');
  await proFamilyWithPlayer(page, 'jordan@example.com', 'Jordan Park', {
    first: 'Eli', last: 'Park', grad: '2028', pos: 'attack', hs: 'Garden City HS', state: 'NY', gpa: '3.8', club: 'Long Island Express',
  });

  await page.goto(`${BASE}#/profile`);
  await page.fill('#profile-form-jersey', '9');
  await page.fill('#profile-form-st-goals', '44');
  await page.fill('#profile-form-st-assists', '20');
  await page.fill('#profile-form-film', 'https://www.hudl.com/video/example');
  await page.click('#profile-form button[type=submit]');
  await page.getByText('Profile saved.').waitFor();

  await page.check('#card-publish');
  await page.getByText('Your card is live.').waitFor();
  const link = await page.inputValue('#card-link');
  assert.match(link, /\/c\/[a-z2-9]{8}$/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/9-card-section.png` });

  // A coach opens the link in their own browser, not signed in.
  const coach = await run.page('coach', { width: 1280, height: 900 }, { userAgent: DESKTOP_CHROME });
  await coach.goto(link.replace(/^https?:\/\/[^/]+\//, BASE));
  await coach.getByRole('heading', { name: 'Eli Park' }).waitFor({ timeout: 15000 });
  const text = await coach.locator('.rcard').innerText();
  assert.match(text, /Attack · Class of 2028/);
  assert.match(text, /#9/);
  assert.match(text, /44\s*Goals/);
  assert.match(text, /3\.8\s*GPA/);
  assert.match(text, /Garden City HS, NY/);

  if (SHOTS) await coach.screenshot({ path: `${SHOTS}/10-public-card.png`, fullPage: true });

  // The family sees the view.
  await page.locator('#card-stats', { hasText: /Views, 30 days\s*1/ }).waitFor({ timeout: 15000 });

  // The family can switch to first name + last initial.
  await page.selectOption('#card-name', 'initial');
  await page.getByText('The card now shows the first name and last initial.').waitFor();
  await page.waitForTimeout(1500);
  await coach.reload();
  await coach.getByRole('heading', { name: 'Eli P.' }).waitFor({ timeout: 15000 });
  assert.doesNotMatch(await coach.locator('.rcard').innerText(), /Park\b/, 'last name hidden when chosen');

  // Turning sharing off makes the link show "not available".
  await page.uncheck('#card-publish');
  await page.getByText('Sharing is off.').waitFor();
  await page.waitForTimeout(1500);
  await coach.reload();
  await coach.getByText('This card isn’t available').waitFor({ timeout: 10000 });

  assert.deepEqual(run.errors, [], run.errors.join('; '));
  console.log('e2e card: publish, public page, full name or last initial, view counted, unpublish ✔');
} finally {
  await run.close();
}
