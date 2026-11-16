// Browser test of Phase 0's "done when": a parent signs up, invites the player,
// and both see the same family. Runs against the emulators + hosting:
//   npm run test:e2e
// Set SHOTS=dir to save screenshots.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000/';
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// Serve the Firebase SDK from node_modules when the CDN isn't reachable (CI sandboxes).
async function routeSdk(context) {
  await context.route('https://www.gstatic.com/firebasejs/10.14.1/*', (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    try {
      route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(`node_modules/firebase/${file}`, 'utf8') });
    } catch { route.abort(); }
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
}

async function devSignIn(page, email, name) {
  await page.locator('#dev-form').waitFor();
  await page.fill('#dev-email', email);
  await page.fill('#dev-name', name);
  await page.click('#dev-form button[type=submit]');
  await page.locator('#app').waitFor({ state: 'visible', timeout: 20000 });
}

const browser = await chromium.launch();
const errors = [];
try {
  // Parent
  const parentCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await routeSdk(parentCtx);
  const parent = await parentCtx.newPage();
  parent.on('pageerror', (e) => errors.push(`parent: ${e.message}`));
  await parent.goto(BASE);
  await devSignIn(parent, 'pat@example.com', 'Pat Morrison');

  await parent.getByText('You’re looking at a sample family.').waitFor();
  assert.equal(await parent.textContent('#plan-badge'), 'Free');
  if (SHOTS) await parent.screenshot({ path: `${SHOTS}/1-home-free.png`, fullPage: true });

  // Rename the family, then invite the player.
  await parent.goto(`${BASE}#/profile`);
  await parent.fill('#fam-name', 'Morrison family');
  await parent.click('#save-name');
  await parent.getByText('Saved.').waitFor();
  await parent.click('[data-invite="player"]');
  await parent.locator('#invite-out').waitFor({ state: 'visible' });
  const inviteUrl = await parent.inputValue('#invite-link');
  assert.match(inviteUrl, /invite=[A-Z2-9]{10}/);

  // Player opens the link in their own browser and signs in.
  const playerCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await routeSdk(playerCtx);
  const player = await playerCtx.newPage();
  player.on('pageerror', (e) => errors.push(`player: ${e.message}`));
  await player.goto(inviteUrl.replace(/^https?:\/\/[^/]+\//, BASE));
  await player.getByText('You’ve been invited to join a family').waitFor();
  await devSignIn(player, 'jake@example.com', 'Jake Morrison');
  await player.goto(`${BASE}#/profile`);
  await player.getByText('Jake Morrison (you)').waitFor();
  assert.equal(await player.inputValue('#fam-name'), 'Morrison family');
  await player.getByText('Pat Morrison').waitFor();
  if (SHOTS) await player.screenshot({ path: `${SHOTS}/2-profile-player.png`, fullPage: true });

  // The parent sees the player appear live.
  await parent.getByText('Jake Morrison').waitFor({ timeout: 10000 });
  assert.equal(await parent.locator('#members > div').count(), 2);

  // Tabs render for a free account.
  for (const tab of ['schools', 'coaches', 'events']) {
    await parent.goto(`${BASE}#/${tab}`);
    await parent.getByText('You’re looking at a sample family.').waitFor();
  }
  if (SHOTS) await parent.screenshot({ path: `${SHOTS}/3-schools.png`, fullPage: true });

  // Sign out returns to the sign-in screen.
  await parent.goto(`${BASE}#/profile`);
  await parent.click('#sign-out');
  await parent.locator('#signin').waitFor({ state: 'visible' });

  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  console.log('e2e: parent signed up, invited the player, both see the same family ✔');
} finally {
  await browser.close();
}
