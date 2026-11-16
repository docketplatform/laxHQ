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

async function fillPlayer(page, id, v) {
  if (v.sport) await page.selectOption(`#${id}-sport`, v.sport);
  await page.fill(`#${id}-first`, v.first);
  await page.fill(`#${id}-last`, v.last);
  await page.selectOption(`#${id}-grad`, v.grad);
  await page.selectOption(`#${id}-pos`, v.pos);
  if (v.hs) await page.fill(`#${id}-hs`, v.hs);
  if (v.state) await page.selectOption(`#${id}-hss`, v.state);
  if (v.gpa) await page.fill(`#${id}-gpa`, v.gpa);
  if (v.club) await page.fill(`#${id}-club`, v.club);
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
const consoleLog = [];
process.on('exit', (code) => { if (code) console.log('BROWSER CONSOLE:\n' + consoleLog.slice(-25).join('\n')); });
const watch = (page, who) => page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleLog.push(`${who} ${m.type()}: ${m.text()}`); });
try {
  // Parent
  const parentCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await routeSdk(parentCtx);
  const parent = await parentCtx.newPage();
  parent.on('pageerror', (e) => errors.push(`parent: ${e.message}`));
  watch(parent, 'parent');
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
  watch(player, 'player');
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

  // ---- Phase 1: Pro family sets up a player ----
  await parent.goto(`${BASE}#/profile`);
  await parent.click('[data-dev-plan="pro"]');
  await parent.locator('#plan-badge', { hasText: 'Pro' }).waitFor({ timeout: 15000 });
  await parent.goto(`${BASE}#/home`);
  await parent.getByText('Welcome to LaxHQ Pro').waitFor();
  await parent.click('text=Set up my player');
  await fillPlayer(parent, 'onboard', { first: 'Jake', last: 'Morrison', grad: '2029', pos: 'midfield', hs: 'Severn Ridge HS', state: 'MD', gpa: '3.7', club: 'Chesapeake Elite' });
  await parent.click('#onboard button[type=submit]');
  await parent.getByRole('heading', { name: 'Jake · Class of 2029' }).waitFor({ timeout: 15000 });
  const days = Number(await parent.locator('#countdown .big').textContent());
  const expected = Math.round((new Date(2027, 8, 1) - new Date(new Date().toDateString())) / 864e5);
  assert.equal(days, expected, 'countdown days to Sept 1, 2027');
  if (SHOTS) await parent.screenshot({ path: `${SHOTS}/4-home-pro.png`, fullPage: true });

  // Check off the first step on Home; it persists across a reload.
  const firstTick = parent.locator('#view .tick').first();
  const stepName = await firstTick.getAttribute('aria-label');
  await firstTick.click();
  await parent.waitForTimeout(800);
  await parent.goto(`${BASE}#/plan`);
  await parent.reload();
  await parent.getByRole('heading', { name: 'Jake’s plan' }).waitFor({ timeout: 15000 });
  assert.equal(await parent.locator(`#view .tick[aria-label="${stepName}"]`).first().getAttribute('aria-checked'), 'true');

  // Custom task on the full plan.
  await parent.fill('#ct-title', 'Call Coach Reyes back');
  await parent.fill('#ct-due', new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10));
  await parent.click('#custom-task button[type=submit]');
  await parent.getByText('Call Coach Reyes back').first().waitFor();
  if (SHOTS) await parent.screenshot({ path: `${SHOTS}/5-plan.png`, fullPage: true });

  // Profile edits are saved through the server.
  await parent.goto(`${BASE}#/profile`);
  await parent.fill('#profile-form-jersey', '22');
  await parent.fill('#profile-form-st-goals', '31');
  await parent.click('#profile-form button[type=submit]');
  await parent.getByText('Profile saved.').waitFor();
  await parent.reload();
  assert.equal(await parent.inputValue('#profile-form-jersey'), '22');

  // The player sees the same plan live.
  await player.goto(`${BASE}#/home`);
  await player.getByRole('heading', { name: 'Jake · Class of 2029' }).waitFor({ timeout: 15000 });

  // A sibling needs the add-on; with it, a second player appears in the switcher.
  await parent.goto(`${BASE}#/onboarding`);
  await parent.getByText('Your plan covers 1 player.').waitFor();
  await parent.goto(`${BASE}#/profile`);
  await parent.click('[data-dev-plan="pro2"]');
  await parent.waitForTimeout(1500);
  await parent.goto(`${BASE}#/onboarding`);
  await fillPlayer(parent, 'onboard', { first: 'Sam', last: 'Morrison', grad: '2031', pos: 'goalie' });
  await parent.click('#onboard button[type=submit]');
  await parent.getByRole('heading', { name: 'Sam · Class of 2031' }).waitFor({ timeout: 15000 });
  await parent.getByRole('tab', { name: 'Jake' }).click();
  await parent.getByRole('heading', { name: 'Jake · Class of 2029' }).waitFor();

  // Sign out returns to the sign-in screen.
  await parent.goto(`${BASE}#/profile`);
  await parent.click('#sign-out');
  await parent.locator('#signin').waitFor({ state: 'visible' });

  // ---- A free family fills in onboarding; it's saved the moment they go Pro ----
  const freeCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await routeSdk(freeCtx);
  const fresh = await freeCtx.newPage();
  fresh.on('pageerror', (e) => errors.push(`fresh: ${e.message}`));
  watch(fresh, 'fresh');
  await fresh.goto(BASE);
  await devSignIn(fresh, 'riley@example.com', 'Riley Chen');
  await fresh.click('text=Set up my player');
  await fillPlayer(fresh, 'onboard', { first: 'Ava', last: 'Chen', grad: '2030', pos: 'draw', sport: 'wlax' });
  await fresh.click('#onboard button[type=submit]');
  await fresh.getByText('Saved in this browser.').waitFor();
  await fresh.goto(`${BASE}#/profile`);
  await fresh.click('[data-dev-plan="pro"]');
  await fresh.getByRole('heading', { name: 'Ava · Class of 2030' }).waitFor({ timeout: 20000 });

  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  console.log('e2e: family + invites ✔  player setup, countdown, checklist, profile, siblings, draft-to-Pro ✔');
} finally {
  await browser.close();
}
