// A tiny stand-in for the Stripe API endpoints LaxHQ calls. Tests set subscriptions by id.
import http from 'node:http';

export const STRIPE_MOCK_PORT = 12111;

/** Parse Stripe's form encoding (line_items[0][price]=…) into nested objects. */
function parseForm(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    const keys = k.replace(/\]/g, '').split('[');
    let o = out;
    keys.forEach((key, i) => {
      if (i === keys.length - 1) o[key] = v;
      else { o[key] = o[key] || (/^\d+$/.test(keys[i + 1]) ? [] : {}); o = o[key]; }
    });
  }
  return out;
}

export function startMockStripe() {
  const requests = []; const subscriptions = {}; let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = parseForm(raw);
      requests.push({ method: req.method, url: req.url, body });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Request-Id': `req_${n}` }); res.end(JSON.stringify(obj)); };
      n += 1;
      if (req.method === 'POST' && req.url === '/v1/customers') return send(200, { id: `cus_test_${n}`, object: 'customer', email: body.email || null, metadata: body.metadata || {} });
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') return send(200, { id: `cs_test_${n}`, object: 'checkout.session', url: `https://checkout.stripe.test/cs_test_${n}` });
      if (req.method === 'POST' && req.url === '/v1/billing_portal/sessions') return send(200, { id: `bps_${n}`, object: 'billing_portal.session', url: 'https://billing.stripe.test/portal' });
      const m = req.url.match(/^\/v1\/subscriptions\/([^/?]+)/);
      if (req.method === 'GET' && m) return subscriptions[m[1]] ? send(200, subscriptions[m[1]]) : send(404, { error: { type: 'invalid_request_error', message: 'No such subscription' } });
      return send(404, { error: { type: 'invalid_request_error', message: `Unhandled ${req.method} ${req.url}` } });
    });
  });
  return new Promise((resolve) => server.listen(STRIPE_MOCK_PORT, '127.0.0.1', () => resolve({
    requests, subscriptions, close: () => new Promise((r) => server.close(r)),
  })));
}

/** A Stripe subscription object as LaxHQ reads it. */
export function subscription({ id = 'sub_test_1', customer, fid, status = 'active', interval = 'year', siblings = 0 }) {
  const items = [{ id: 'si_1', quantity: 1, price: { id: interval === 'year' ? 'price_pro_year' : 'price_pro_month', recurring: { interval } } }];
  if (siblings) items.push({ id: 'si_2', quantity: siblings, price: { id: 'price_sibling_year', recurring: { interval: 'year' } } });
  return {
    id, object: 'subscription', customer, status, metadata: fid ? { fid } : {}, cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400, items: { object: 'list', data: items },
  };
}
