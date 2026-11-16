// Fetching club calendar feeds safely: public hosts only, limited size and time, manual redirects.
const dns = require('node:dns/promises');
const net = require('node:net');

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const USER_AGENT = 'LaxHQ-CalendarSync/1.0 (+https://laxhq.netlify.app)';

/** Private, loopback, link-local, metadata and other non-public addresses. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

async function assertPublicHost(hostname) {
  if (process.env.FUNCTIONS_EMULATOR === 'true') return; // local test feeds
  if (/^(localhost|metadata(\.google\.internal)?)$/i.test(hostname)) throw new Error('That link points to a private address.');
  const addrs = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('That link points to a private address.');
}

/**
 * GET a feed. Returns { status: 200, text, etag, lastModified } or { status: 304 }.
 * Throws an Error with a family-friendly message on anything else.
 */
async function fetchFeed(url, { etag = null, lastModified = null } = {}) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Calendar links must be web links.');
    if (u.protocol === 'http:' && process.env.FUNCTIONS_EMULATOR !== 'true') u.protocol = 'https:';
    await assertPublicHost(u.hostname);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(u, {
        redirect: 'manual', signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/calendar, text/plain, */*', ...(etag ? { 'If-None-Match': etag } : {}), ...(lastModified ? { 'If-Modified-Since': lastModified } : {}) },
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e.name === 'AbortError' ? 'The calendar took too long to respond.' : 'Couldn’t reach that calendar link.');
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      clearTimeout(timer);
      const loc = res.headers.get('location');
      if (!loc) throw new Error('The calendar link redirected nowhere.');
      current = new URL(loc, u).toString();
      continue;
    }
    if (res.status === 304) { clearTimeout(timer); return { status: 304 }; }
    if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
      clearTimeout(timer);
      throw new Error('That calendar link no longer works. Copy a fresh link from your team app.');
    }
    if (!res.ok) { clearTimeout(timer); throw new Error(`The calendar returned an error (${res.status}).`); }
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { ctrl.abort(); throw new Error('That calendar is too large to import.'); }
        chunks.push(value);
      }
    } finally { clearTimeout(timer); }
    return {
      status: 200, text: Buffer.concat(chunks).toString('utf8'),
      etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'),
    };
  }
  throw new Error('The calendar link redirected too many times.');
}

module.exports = { fetchFeed, isPrivateAddress };
