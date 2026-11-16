import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initializeApp, getApps } = require('../../functions/node_modules/firebase-admin/lib/app/index.js');
if (!getApps().length) initializeApp({ projectId: 'demo-laxhq' });
const { stripeState, pickEntitlement, revenuecatState } = require('../../functions/billing.js');

const PRICES = { year: 'price_pro_year', month: 'price_pro_month', sibling: 'price_sibling_year' };
const sub = (o = {}) => ({
  id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, current_period_end: 1893456000,
  items: { data: [{ quantity: 1, price: { id: 'price_pro_year', recurring: { interval: 'year' } } }, ...(o.siblings ? [{ quantity: o.siblings, price: { id: 'price_sibling_year', recurring: { interval: 'year' } } }] : [])] },
  ...o,
});

test('Stripe subscriptions map to plan state, siblings add players', () => {
  const st = stripeState(sub({ siblings: 2 }), PRICES);
  assert.equal(st.active, true);
  assert.equal(st.interval, 'year');
  assert.equal(st.maxPlayers, 3);
  assert.equal(st.customerId, 'cus_1');
  assert.equal(stripeState(sub({ status: 'past_due' }), PRICES).active, true);
  assert.equal(stripeState(sub({ status: 'canceled' }), PRICES).active, false);
  assert.equal(stripeState(sub({ status: 'incomplete_expired' }), PRICES).active, false);
  assert.equal(stripeState(sub({ siblings: 40 }), PRICES).maxPlayers, 6, 'capped at 5 siblings');
});

test('entitlement: free without an active source; Pro from Stripe, RevenueCat or a seat', () => {
  assert.equal(pickEntitlement({}).plan, 'free');
  assert.equal(pickEntitlement({ stripe: { active: false } }).plan, 'free');
  const s = pickEntitlement({ stripe: { active: true, status: 'active', interval: 'year', maxPlayers: 2 } });
  assert.deepEqual([s.plan, s.source, s.status, s.maxPlayers], ['pro', 'stripe', 'active', 2]);
  const past = pickEntitlement({ stripe: { active: true, status: 'past_due', maxPlayers: 1 } });
  assert.equal(past.status, 'past_due');
  const rc = pickEntitlement({ revenuecat: { active: true, expiresAt: new Date(Date.now() + 864e5), maxPlayers: 1 } });
  assert.equal(rc.source, 'revenuecat');
  assert.equal(pickEntitlement({ revenuecat: { active: true, expiresAt: new Date(Date.now() - 1000) } }).plan, 'free', 'expired');
  const both = pickEntitlement({ stripe: { active: true, status: 'past_due', maxPlayers: 1 }, revenuecat: { active: true, maxPlayers: 1 } });
  assert.equal(both.source, 'revenuecat', 'a fully active source wins over past_due');
  assert.equal(pickEntitlement({ stripe: { active: true, status: 'active', maxPlayers: 1 }, org: { active: true, maxPlayers: 3, orgId: 'o1' } }).maxPlayers, 3);
});

test('RevenueCat events map to plan state', () => {
  const now = Date.now();
  const buy = revenuecatState({ type: 'INITIAL_PURCHASE', expiration_at_ms: now + 864e5, product_id: 'laxhq_pro_year', store: 'APP_STORE' }, now);
  assert.equal(buy.active, true);
  assert.equal(buy.interval, 'year');
  const cancel = revenuecatState({ type: 'CANCELLATION', expiration_at_ms: now + 864e5 }, now);
  assert.equal(cancel.active, true, 'still Pro until the period ends');
  assert.equal(cancel.willRenew, false);
  assert.equal(revenuecatState({ type: 'EXPIRATION', expiration_at_ms: now - 1 }, now).active, false);
  assert.equal(revenuecatState({ type: 'BILLING_ISSUE', expiration_at_ms: now + 864e5 }, now).billingIssue, true);
  assert.equal(revenuecatState({ type: 'RENEWAL', product_id: 'laxhq_pro_month', expiration_at_ms: now + 864e5 }, now).interval, 'month');
});
