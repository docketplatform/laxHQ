// Billing (Phase 6): Stripe Checkout + Customer Portal on the web, RevenueCat for iOS.
//
// Each source writes its own state to families/{fid}/billing/{stripe|revenuecat} (server-only).
// resolveEntitlement(fid) then picks the best active source and writes families/{fid}.entitlement,
// updating every member's `pro` claim first (applyEntitlement).

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const StripeSDK = require('stripe');

const db = getFirestore();
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const REVENUECAT_WEBHOOK_AUTH = defineSecret('REVENUECAT_WEBHOOK_AUTH');
const PRICE_PRO_YEAR = defineString('STRIPE_PRICE_PRO_YEAR', { default: '' });
const PRICE_PRO_MONTH = defineString('STRIPE_PRICE_PRO_MONTH', { default: '' });
const PRICE_SIBLING_YEAR = defineString('STRIPE_PRICE_SIBLING_YEAR', { default: '' });
const MAX_SIBLINGS = 5;

let helpers = null;
function init(h) { helpers = h; }

/** Stripe client. STRIPE_API_HOST/PORT/PROTOCOL point it at a local mock in the emulator tests. */
function stripe() {
  const opts = { apiVersion: '2024-06-20', maxNetworkRetries: 2 };
  if (process.env.STRIPE_API_HOST) {
    Object.assign(opts, { host: process.env.STRIPE_API_HOST, port: Number(process.env.STRIPE_API_PORT || 443), protocol: process.env.STRIPE_API_PROTOCOL || 'https' });
  }
  return new StripeSDK(STRIPE_SECRET_KEY.value(), opts);
}

function checkOrigin(origin) {
  try {
    const u = new URL(String(origin || ''));
    if (!['https:', 'http:'].includes(u.protocol)) throw new Error();
    return u.origin;
  } catch { throw new HttpsError('invalid-argument', 'appOrigin must be the app’s web address.'); }
}

async function familyOf(req) {
  const uid = helpers.requireAuth(req);
  const user = await db.doc(`users/${uid}`).get();
  const fid = user.get('familyId');
  if (!fid) throw new HttpsError('failed-precondition', 'Set up your family first.');
  return { uid, fid, email: user.get('email') || null, famRef: db.doc(`families/${fid}`) };
}

// ---------- entitlement ----------

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

/** Pure: Stripe subscription → our billing state. */
function stripeState(sub, prices = { year: PRICE_PRO_YEAR.value(), month: PRICE_PRO_MONTH.value(), sibling: PRICE_SIBLING_YEAR.value() }) {
  const items = sub.items?.data || [];
  const pro = items.find((i) => [prices.year, prices.month].includes(i.price?.id)) || items.find((i) => i.price?.id !== prices.sibling);
  const siblings = items.filter((i) => i.price?.id === prices.sibling).reduce((n, i) => n + (i.quantity || 0), 0);
  const status = sub.status === 'trialing' ? 'active' : sub.status;
  return {
    subscriptionId: sub.id, customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    status, active: ACTIVE.has(sub.status),
    interval: pro?.price?.recurring?.interval || null,
    maxPlayers: 1 + Math.min(siblings, MAX_SIBLINGS),
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
}

/** Pure: pick the entitlement from the sources (Stripe, RevenueCat, club/advisor seat). */
function pickEntitlement({ stripe: st, revenuecat: rc, org } = {}, now = new Date()) {
  const live = (s) => s && s.active && (!s.expiresAt || new Date(s.expiresAt) > now);
  const choices = [];
  if (live(st)) choices.push({ source: 'stripe', status: st.status === 'past_due' ? 'past_due' : 'active', interval: st.interval, currentPeriodEnd: st.currentPeriodEnd || null, maxPlayers: st.maxPlayers || 1 });
  if (live(rc)) choices.push({ source: 'revenuecat', status: rc.billingIssue ? 'past_due' : 'active', interval: rc.interval || 'year', currentPeriodEnd: rc.expiresAt ? new Date(rc.expiresAt) : null, maxPlayers: rc.maxPlayers || 1 });
  if (live(org)) choices.push({ source: 'org', status: 'active', interval: null, currentPeriodEnd: null, maxPlayers: org.maxPlayers || 1, orgId: org.orgId });
  if (!choices.length) return { plan: 'free', source: null, interval: null, status: null, currentPeriodEnd: null, maxPlayers: 0, orgId: null };
  // Prefer a fully active source; among equals, the one covering more players.
  choices.sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.maxPlayers - a.maxPlayers);
  const best = choices[0];
  return { plan: 'pro', orgId: null, ...best, maxPlayers: Math.max(...choices.map((c) => c.maxPlayers)) };
}

async function resolveEntitlement(fid) {
  const billing = await db.collection(`families/${fid}/billing`).get();
  const sources = Object.fromEntries(billing.docs.map((d) => [d.id, d.data()]));
  for (const s of Object.values(sources)) {
    if (s.currentPeriodEnd?.toDate) s.currentPeriodEnd = s.currentPeriodEnd.toDate();
    if (s.expiresAt?.toDate) s.expiresAt = s.expiresAt.toDate();
  }
  const ent = pickEntitlement(sources);
  await helpers.applyEntitlement(fid, ent);
  return ent;
}

// ---------- checkout and portal ----------

/**
 * createCheckout — Stripe Checkout for Pro.
 * data: { interval: 'year'|'month', siblings?: 0-5 (annual only), appOrigin } → { url }
 */
const createCheckout = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (req) => {
  const { fid, email, famRef } = await familyOf(req);
  const origin = checkOrigin(req.data?.appOrigin);
  const interval = req.data?.interval === 'month' ? 'month' : 'year';
  const siblings = Math.max(0, Math.min(MAX_SIBLINGS, Math.floor(Number(req.data?.siblings) || 0)));
  if (siblings && interval !== 'year') throw new HttpsError('invalid-argument', 'The sibling add-on is available on the annual plan.');
  const fam = await famRef.get();
  const ent = fam.get('entitlement') || {};
  if (ent.plan === 'pro' && ent.source === 'stripe') throw new HttpsError('failed-precondition', 'You already have Pro. Use Manage billing to change your plan.');
  const price = interval === 'year' ? PRICE_PRO_YEAR.value() : PRICE_PRO_MONTH.value();
  if (!price || (siblings && !PRICE_SIBLING_YEAR.value())) throw new HttpsError('failed-precondition', 'Checkout isn’t set up yet.');

  const s = stripe();
  let customerId = fam.get('stripeCustomerId');
  if (!customerId) {
    const customer = await s.customers.create({ email: email || undefined, name: fam.get('name') || undefined, metadata: { fid } });
    customerId = customer.id;
    await famRef.update({ stripeCustomerId: customerId });
  }
  const lineItems = [{ price, quantity: 1 }];
  if (siblings) lineItems.push({ price: PRICE_SIBLING_YEAR.value(), quantity: siblings });
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: fid,
    line_items: lineItems,
    subscription_data: { metadata: { fid } },
    allow_promotion_codes: true,
    success_url: `${origin}/?checkout=success#/home`,
    cancel_url: `${origin}/#/profile`,
  });
  return { url: session.url };
});

/** createPortal — Stripe Customer Portal (change plan, card, cancel, invoices). data: { appOrigin } → { url } */
const createPortal = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (req) => {
  const { famRef } = await familyOf(req);
  const origin = checkOrigin(req.data?.appOrigin);
  const customerId = (await famRef.get()).get('stripeCustomerId');
  if (!customerId) throw new HttpsError('failed-precondition', 'There’s no web subscription on this account.');
  const portal = await stripe().billingPortal.sessions.create({ customer: customerId, return_url: `${origin}/#/profile` });
  return { url: portal.url };
});

// ---------- webhooks ----------

async function fidForCustomer(customerId, hinted) {
  if (hinted) return hinted;
  const q = await db.collection('families').where('stripeCustomerId', '==', customerId).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}

async function syncSubscription(sub, hintedFid = null) {
  const st = stripeState(sub);
  const fid = await fidForCustomer(st.customerId, hintedFid || sub.metadata?.fid);
  if (!fid) { console.warn('stripe: no family for customer', st.customerId); return null; }
  await db.doc(`families/${fid}/billing/stripe`).set({ ...st, updatedAt: FieldValue.serverTimestamp() });
  return { fid, ent: await resolveEntitlement(fid) };
}

/** The LaxHQ charge shows up in the family's recruiting spend. */
async function recordInvoiceExpense(invoice) {
  const fid = await fidForCustomer(invoice.customer, invoice.subscription_details?.metadata?.fid || invoice.metadata?.fid);
  if (!fid || !invoice.amount_paid) return;
  const paid = new Date((invoice.status_transitions?.paid_at || invoice.created) * 1000);
  const date = paid.toISOString().slice(0, 10);
  const startYear = paid.getUTCMonth() >= 8 ? paid.getUTCFullYear() : paid.getUTCFullYear() - 1;
  await db.doc(`families/${fid}/expenses/laxhq_${invoice.id}`).set({
    amountCents: invoice.amount_paid, date, season: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
    category: 'services', payee: 'LaxHQ Pro', note: invoice.number ? `Invoice ${invoice.number}` : null,
    playerIds: [], status: 'spent', source: 'laxhq', createdAt: FieldValue.serverTimestamp(),
  });
}

const stripeWebhook = onRequest({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('POST only'); return; }
  let event;
  try {
    event = StripeSDK.webhooks.constructEvent(req.rawBody, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET.value());
  } catch (e) {
    res.status(400).send(`Webhook signature check failed: ${e.message}`);
    return;
  }
  // Idempotency: each event is handled once.
  const seen = db.doc(`billingEvents/${event.id}`);
  try { await seen.create({ type: event.type, at: FieldValue.serverTimestamp(), source: 'stripe' }); } catch (e) {
    if (e.code === 6) { res.json({ received: true, duplicate: true }); return; }
    throw e;
  }
  try {
    const o = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
        if (o.mode === 'subscription' && o.subscription) {
          const fid = o.client_reference_id || o.metadata?.fid;
          if (fid && o.customer) await db.doc(`families/${fid}`).set({ stripeCustomerId: o.customer }, { merge: true });
          await syncSubscription(await stripe().subscriptions.retrieve(o.subscription), fid);
        }
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(o);
        break;
      case 'invoice.paid':
        await recordInvoiceExpense(o);
        break;
      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    await seen.delete().catch(() => {}); // let Stripe retry
    console.error('stripe webhook', event.type, e);
    res.status(500).send('error');
  }
});

/** Pure: RevenueCat webhook event → our billing state. */
function revenuecatState(ev, now = Date.now()) {
  const expiresAt = ev.expiration_at_ms ? new Date(ev.expiration_at_ms) : null;
  const ended = ev.type === 'EXPIRATION' || (expiresAt && expiresAt.getTime() <= now);
  return {
    active: !ended, expiresAt, productId: ev.product_id || null, store: ev.store || null,
    billingIssue: ev.type === 'BILLING_ISSUE', willRenew: !['CANCELLATION', 'EXPIRATION'].includes(ev.type),
    interval: /month/i.test(ev.product_id || '') ? 'month' : 'year', maxPlayers: 1, lastEventType: ev.type,
  };
}

/** RevenueCat webhook (iOS). app_user_id = the family id. Authorization header = shared secret. */
const revenuecatWebhook = onRequest({ secrets: [REVENUECAT_WEBHOOK_AUTH] }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('POST only'); return; }
  if (req.get('authorization') !== `Bearer ${REVENUECAT_WEBHOOK_AUTH.value()}`) { res.status(401).send('unauthorized'); return; }
  const ev = req.body?.event;
  if (!ev || !ev.id || !ev.app_user_id) { res.status(400).send('bad event'); return; }
  const seen = db.doc(`billingEvents/rc_${ev.id}`);
  try { await seen.create({ type: ev.type, at: FieldValue.serverTimestamp(), source: 'revenuecat' }); } catch (e) {
    if (e.code === 6) { res.json({ received: true, duplicate: true }); return; }
    throw e;
  }
  const fid = String(ev.app_user_id);
  if (ev.type === 'TEST' || !(await db.doc(`families/${fid}`).get()).exists) { res.json({ received: true, ignored: true }); return; }
  await db.doc(`families/${fid}/billing/revenuecat`).set({ ...revenuecatState(ev), updatedAt: FieldValue.serverTimestamp() });
  await resolveEntitlement(fid);
  res.json({ received: true });
});

module.exports = {
  init, createCheckout, createPortal, stripeWebhook, revenuecatWebhook, stripeClient: stripe,
  stripeState, pickEntitlement, revenuecatState, resolveEntitlement,
};
