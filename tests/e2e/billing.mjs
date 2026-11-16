// Phase 6 scenario: a free family fills in onboarding, buys Pro through Stripe Checkout,
// the webhook unlocks Pro, their answers are saved, and Manage billing opens the portal.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BASE, SHOTS, launch, devSignIn, fillPlayer } from './helpers.mjs';
import { startMockStripe, subscription } from '../mock-stripe.mjs';

const StripeLib = createRequire(import.meta.url)('../../functions/node_modules/stripe');
const signer = new (StripeLib.default || StripeLib)('sk_test_emulator');
let n = 0;
async function hook(type, object) {
  const payload = JSON.stringify({ id: `evt_e2e_${Date.now()}_${n++}`, object: 'event', type, data: { object } });
  const res = await fetch('http://127.0.0.1:5001/demo-laxhq/us-central1/stripeWebhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signer.webhooks.generateTestHeaderString({ payload, secret: 'whsec_emulator' }) }, body: payload,
  });
  assert.equal(res.status, 200, await res.text());
}

const stripe = await startMockStripe();
const run = await launch();
try {
  const page = await run.page('billing');
  await page.context().route(/https:\/\/(checkout|billing)\.stripe\.test\/.*/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe</h1>' }));
  await devSignIn(page, 'avery@example.com', 'Avery Brooks');

  // Free: fill in onboarding first; it's kept in the browser.
  await page.goto(`${BASE}#/onboarding`);
  await fillPlayer(page, 'onboard', { first: 'Mia', last: 'Brooks', grad: '2030', pos: 'midfield', sport: 'wlax', gpa: '3.9' });
  await page.click('#onboard button[type=submit]');
  await page.getByText('Saved in this browser.').waitFor();

  // Start Pro yearly with one sibling → Stripe Checkout.
  await page.goto(`${BASE}#/profile`);
  await page.selectOption('#siblings', '1');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/15-start-pro.png`, fullPage: true });
  await Promise.all([page.waitForURL(/checkout\.stripe\.test/), page.click('[data-checkout="year"]')]);
  const session = stripe.requests.filter((r) => r.url === '/v1/checkout/sessions').at(-1).body;
  const fid = session.client_reference_id;
  assert.ok(fid);
  assert.deepEqual(session.line_items.map((l) => [l.price, l.quantity]), [['price_pro_year', '1'], ['price_sibling_year', '1']]);

  // Stripe confirms payment.
  const cust = session.customer;
  stripe.subscriptions.sub_e2e = subscription({ id: 'sub_e2e', customer: cust, fid, siblings: 1 });
  await hook('checkout.session.completed', { id: 'cs_e2e', object: 'checkout.session', mode: 'subscription', subscription: 'sub_e2e', customer: cust, client_reference_id: fid });
  await hook('invoice.paid', { id: 'in_e2e', object: 'invoice', customer: cust, amount_paid: 59900, number: 'LAX-E2E', created: Math.floor(Date.now() / 1000) });

  // Back from Checkout: Pro is on and the kept answers became the player.
  await page.goto(`${BASE.replace(/\/$/, '')}/?checkout=success#/home`);
  await page.getByText('Welcome to LaxHQ Pro.').waitFor({ timeout: 15000 });
  await page.getByRole('heading', { name: 'Mia · Class of 2030' }).waitFor({ timeout: 20000 });
  assert.equal(await page.textContent('#plan-badge'), 'Pro');

  // Plan covers 2 players; the LaxHQ charge is in recruiting spend.
  await page.goto(`${BASE}#/profile`);
  await page.locator('#plan-card', { hasText: 'Covers 2 players' }).waitFor();
  await page.goto(`${BASE}#/spend`);
  await page.locator('.list', { hasText: 'LaxHQ Pro' }).waitFor({ timeout: 10000 });
  assert.match(await page.locator('.list').innerText(), /Added automatically[\s\S]*\$599/);

  // Manage billing opens the Stripe Customer Portal.
  await page.goto(`${BASE}#/profile`);
  await Promise.all([page.waitForURL(/billing\.stripe\.test/), page.click('#manage-billing')]);

  assert.deepEqual(run.errors, [], run.errors.join('; '));
  console.log('e2e billing: onboarding kept, Stripe Checkout with sibling, webhook unlocks Pro, draft saved, LaxHQ expense, portal ✔');
} finally {
  await run.close();
  await stripe.close();
}
