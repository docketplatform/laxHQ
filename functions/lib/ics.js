// Club schedule feeds: link normalization and iCalendar parsing. Pure functions; unit tested.
const crypto = require('node:crypto');
const ical = require('node-ical');

const DEFAULT_TZ = 'America/New_York';

/**
 * Normalize a pasted calendar link so the same feed always hashes the same:
 * webcal:// → https://, lowercase host, sorted query params, no trailing slash, no #fragment.
 * Throws on anything that isn't a web link.
 */
function normalizeFeedUrl(raw, { allowHttp = false } = {}) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('Paste the calendar link.');
  s = s.replace(/^webcals?:\/\//i, 'https://');
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('That doesn’t look like a calendar link.'); }
  if (u.protocol === 'http:' && !allowHttp) u.protocol = 'https:';
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Calendar links must start with https:// or webcal://');
  if (u.username || u.password) throw new Error('Calendar links can’t include a username or password.');
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  let out = u.toString();
  if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
  return out;
}

const urlHash = (normalized) => crypto.createHash('sha256').update(normalized).digest('hex');

/** yyyy-mm-dd of a Date as seen in a time zone. */
function localDate(date, tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** yyyy-mm-dd from a date-only value (node-ical builds these at local midnight of the server). */
function dateOnly(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

const text = (v) => (v == null ? '' : typeof v === 'string' ? v : (v.val ?? String(v))).trim();
const isValidTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/** The name an event is filed under: its first CATEGORIES value, else the calendar's name. */
function calendarOf(ev, calName) {
  const cats = Array.isArray(ev.categories) ? ev.categories : ev.categories ? [ev.categories] : [];
  return text(cats[0]) || calName || 'Calendar';
}

function toEvent(ev, start, end, calName, uidSuffix = '') {
  const allDay = ev.datetype === 'date';
  const tz = ev.start?.tz && isValidTz(ev.start.tz) ? ev.start.tz : DEFAULT_TZ;
  let startDate; let endDate;
  if (allDay) {
    startDate = dateOnly(start);
    // DTEND of an all-day event is exclusive.
    endDate = end ? addDaysIso(dateOnly(end), -1) : startDate;
    if (endDate < startDate) endDate = startDate;
  } else {
    startDate = localDate(start, tz);
    endDate = end ? localDate(new Date(end.getTime() - 1), tz) : startDate;
  }
  return {
    uid: `${text(ev.uid) || crypto.createHash('sha1').update(`${text(ev.summary)}|${start.toISOString()}`).digest('hex')}${uidSuffix}`,
    baseUid: text(ev.uid) || null,
    title: text(ev.summary).slice(0, 200) || 'Event',
    location: text(ev.location).slice(0, 200) || null,
    allDay,
    start: allDay ? startDate : start.toISOString(),
    end: allDay ? endDate : (end || start).toISOString(),
    startDate, endDate, tz,
    calendar: calendarOf(ev, calName).slice(0, 100),
    cancelled: text(ev.status).toUpperCase() === 'CANCELLED',
  };
}

/**
 * Parse an iCalendar feed into events between now - 1 day and now + horizonDays.
 * Repeating events are expanded; EXDATEs and moved occurrences are honored.
 * @returns {{ calendarName: string|null, calendars: {name: string, count: number}[], events: object[] }}
 */
function parseFeed(icsText, { now = new Date(), horizonDays = 540 } = {}) {
  if (!/BEGIN:VCALENDAR/i.test(icsText)) throw new Error('That link didn’t return a calendar.');
  const data = ical.sync.parseICS(icsText);
  const calName = text(Object.values(data).find((v) => v.type === 'VCALENDAR')?.['WR-CALNAME']) || null;
  const from = new Date(now.getTime() - 864e5);
  const to = new Date(now.getTime() + horizonDays * 864e5);
  const events = [];

  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    const durationMs = ev.end ? ev.end.getTime() - ev.start.getTime() : 0;
    if (ev.rrule) {
      const exdates = new Set(Object.values(ev.exdate || {}).map((d) => d.toISOString()));
      for (const occ of ev.rrule.between(from, to, true)) {
        let start = occ;
        if (ev.datetype === 'date') start = new Date(occ.getUTCFullYear(), occ.getUTCMonth(), occ.getUTCDate());
        const key = dateOnly(start);
        const override = ev.recurrences && (ev.recurrences[key] || ev.recurrences[start.toISOString().slice(0, 10)]);
        if (exdates.has(start.toISOString()) || Object.values(ev.exdate || {}).some((d) => dateOnly(d) === key && ev.datetype === 'date')) continue;
        if (override) {
          events.push(toEvent({ ...override, uid: ev.uid, categories: override.categories || ev.categories, datetype: override.datetype || ev.datetype }, override.start, override.end, calName, `#${key}`));
        } else {
          events.push(toEvent(ev, start, durationMs ? new Date(start.getTime() + durationMs) : null, calName, `#${key}`));
        }
      }
    } else if (ev.start <= to && (ev.end || ev.start) >= from) {
      events.push(toEvent(ev, ev.start, ev.end || null, calName));
    }
  }
  events.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.start.localeCompare(b.start));
  const counts = new Map();
  for (const e of events) counts.set(e.calendar, (counts.get(e.calendar) || 0) + 1);
  return { calendarName: calName, calendars: [...counts].map(([name, count]) => ({ name, count })), events };
}

/** Event ids used as Firestore doc ids (UIDs can contain slashes). */
const eventDocId = (uid) => crypto.createHash('sha1').update(uid).digest('hex').slice(0, 28);

/** Fraction of a team's sample UIDs that also appear in a feed. */
function uidOverlap(sample, feedUids) {
  if (!sample || !sample.length) return 0;
  const set = new Set(feedUids);
  return sample.filter((u) => set.has(u)).length / sample.length;
}

module.exports = { normalizeFeedUrl, urlHash, parseFeed, localDate, eventDocId, uidOverlap, addDaysIso, DEFAULT_TZ };
