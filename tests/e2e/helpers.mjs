// Shared helpers for the browser scenarios. Each scenario signs up its own fresh users.
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

export const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000/';
export const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

export function admin() {
  if (!getApps().length) initializeApp({ projectId: 'demo-laxhq' });
  return getFirestore();
}

/** Launch Chromium; returns { browser, page(name), errors, close() }. Fails the run on page errors. */
export async function launch() {
  const browser = await chromium.launch();
  const errors = []; const logs = [];
  process.on('exit', (code) => { if (code) console.log(`BROWSER CONSOLE:\n${logs.slice(-25).join('\n')}`); });
  async function page(name, viewport = { width: 390, height: 844 }) {
    const ctx = await browser.newContext({ viewport });
    await ctx.route('https://www.gstatic.com/firebasejs/10.14.1/*', (route) => {
      const file = new URL(route.request().url()).pathname.split('/').pop();
      try { route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(`node_modules/firebase/${file}`, 'utf8') }); } catch { route.abort(); }
    });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    p.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/ERR_FAILED/.test(m.text())) logs.push(`${name} ${m.type()}: ${m.text()}`); });
    p.on('dialog', (d) => d.accept());
    return p;
  }
  return { browser, page, errors, close: () => browser.close() };
}

export async function devSignIn(page, email, name) {
  await page.goto(BASE);
  await page.locator('#dev-form').waitFor();
  await page.fill('#dev-email', email);
  await page.fill('#dev-name', name);
  await page.click('#dev-form button[type=submit]');
  await page.locator('#app').waitFor({ state: 'visible', timeout: 20000 });
}

export async function fillPlayer(page, id, v) {
  if (v.sport) await page.selectOption(`#${id}-sport`, v.sport);
  await page.fill(`#${id}-first`, v.first);
  await page.fill(`#${id}-last`, v.last);
  await page.selectOption(`#${id}-grad`, v.grad);
  await page.selectOption(`#${id}-pos`, v.pos);
  if (v.hs) await page.fill(`#${id}-hs`, v.hs);
  if (v.state) await page.selectOption(`#${id}-hss`, v.state);
  if (v.gpa) await page.fill(`#${id}-gpa`, v.gpa);
  if (v.club) await page.fill(`#${id}-club`, v.club);
  if (v.level) await page.selectOption(`#${id}-level`, v.level);
}

export async function setPlan(page, plan) {
  await page.goto(`${BASE}#/profile`);
  await page.click(`[data-dev-plan="${plan}"]`);
  await page.locator('#plan-badge', { hasText: plan === 'free' ? 'Free' : 'Pro' }).waitFor({ timeout: 15000 });
}

/** Sign up, switch to Pro and set up a player. Returns the page on Home. */
export async function proFamilyWithPlayer(page, email, name, player) {
  await devSignIn(page, email, name);
  await setPlan(page, 'pro');
  await page.goto(`${BASE}#/onboarding`);
  await fillPlayer(page, 'onboard', player);
  await page.click('#onboard button[type=submit]');
  await page.getByRole('heading', { name: `${player.first} · Class of ${player.grad}` }).waitFor({ timeout: 15000 });
}

export async function uidFor(email) {
  const res = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:lookup?key=demo-key', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ email: [email] }),
  });
  return (await res.json()).users?.[0]?.localId;
}
