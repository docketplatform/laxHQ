// Serves test calendar feeds over HTTP, like a team app's "subscribe" link.
import http from 'node:http';

export const FEED_PORT = 4600;

/** Build an iCalendar file. events: [{ uid, date, time?, title, cal? }] */
export function ics(events, name = 'Chesapeake Elite') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LaxHQ tests//EN', `X-WR-CALNAME:${name}`];
  for (const e of events) {
    const d = e.date.replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`);
    if (e.time) {
      lines.push(`DTSTART;TZID=America/New_York:${d}T${e.time}00`, `DTEND;TZID=America/New_York:${d}T${String(Number(e.time.slice(0, 2)) + 2).padStart(2, '0')}${e.time.slice(2)}00`);
    } else lines.push(`DTSTART;VALUE=DATE:${d}`);
    lines.push(`SUMMARY:${e.title}`);
    if (e.cal) lines.push(`CATEGORIES:${e.cal}`);
    if (e.location) lines.push(`LOCATION:${e.location}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/** routes: { '/path.ics': string | { status } }. Mutate `routes` to change what a feed returns. */
export function startFeedServer(routes = {}) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    hits[path] = (hits[path] || 0) + 1;
    const r = routes[path];
    if (r === undefined) { res.writeHead(404).end('not found'); return; }
    if (typeof r === 'object') { res.writeHead(r.status).end(r.body || ''); return; }
    res.writeHead(200, { 'Content-Type': 'text/calendar' }).end(r);
  });
  return new Promise((resolve) => server.listen(FEED_PORT, '127.0.0.1', () => resolve({
    routes, hits, url: (p) => `http://127.0.0.1:${FEED_PORT}${p}`, close: () => new Promise((r) => server.close(r)),
  })));
}
