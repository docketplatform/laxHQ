import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeFeedUrl, urlHash, parseFeed, uidOverlap, localDate } = require('../../functions/lib/ics.js');
const { datesOverlap, findOverlaps, overlapAlerts } = require('../../functions/lib/overlap.js');

const ICS = (body, name = 'Chesapeake Elite') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:${name}\r\n${body}END:VCALENDAR\r\n`;
const VEV = (lines) => `BEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT\r\n`;
const now = new Date('2027-05-01T12:00:00Z');

test('feed links normalize to one form', () => {
  const a = normalizeFeedUrl('webcal://Go.TeamSnap.com/ics/abc?b=2&a=1/');
  assert.equal(a, 'https://go.teamsnap.com/ics/abc?a=1%2F&b=2');
  assert.equal(normalizeFeedUrl('webcal://go.teamsnap.com/ics/abc/'), 'https://go.teamsnap.com/ics/abc');
  assert.equal(normalizeFeedUrl('go.teamsnap.com/ics/abc'), 'https://go.teamsnap.com/ics/abc');
  assert.equal(normalizeFeedUrl('http://x.com/c.ics'), 'https://x.com/c.ics');
  assert.equal(normalizeFeedUrl('http://127.0.0.1:4600/c.ics', { allowHttp: true }), 'http://127.0.0.1:4600/c.ics');
  assert.equal(urlHash(normalizeFeedUrl('webcal://x.com/c.ics#frag')), urlHash(normalizeFeedUrl('https://X.com/c.ics')));
  assert.throws(() => normalizeFeedUrl(''), /Paste/);
  assert.throws(() => normalizeFeedUrl('ftp://x.com/c'), /https/);
  assert.throws(() => normalizeFeedUrl('https://u:p@x.com/c'), /username/);
});

test('timed events get the local date of their time zone', () => {
  assert.equal(localDate(new Date('2027-07-25T02:30:00Z'), 'America/New_York'), '2027-07-24');
  const { events, calendars, calendarName } = parseFeed(ICS(VEV([
    'UID:g1@ts', 'DTSTART;TZID=America/New_York:20270724T210000', 'DTEND;TZID=America/New_York:20270724T230000',
    'SUMMARY:Game vs Express', 'LOCATION:Philadelphia PA', 'CATEGORIES:Chesapeake Elite 2029',
  ])), { now });
  assert.equal(calendarName, 'Chesapeake Elite');
  assert.equal(events.length, 1);
  assert.equal(events[0].startDate, '2027-07-24');
  assert.equal(events[0].calendar, 'Chesapeake Elite 2029');
  assert.equal(events[0].location, 'Philadelphia PA');
  assert.deepEqual(calendars, [{ name: 'Chesapeake Elite 2029', count: 1 }]);
});

test('all-day events: DTEND is exclusive', () => {
  const { events } = parseFeed(ICS(VEV(['UID:t1', 'DTSTART;VALUE=DATE:20270724', 'DTEND;VALUE=DATE:20270727', 'SUMMARY:Tournament'])), { now });
  assert.equal(events[0].allDay, true);
  assert.equal(events[0].startDate, '2027-07-24');
  assert.equal(events[0].endDate, '2027-07-26');
});

test('repeating events expand, skip EXDATEs, and stay inside the window', () => {
  const { events } = parseFeed(ICS(VEV([
    'UID:p1', 'DTSTART;TZID=America/New_York:20270601T180000', 'DTEND;TZID=America/New_York:20270601T200000',
    'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;TZID=America/New_York:20270608T180000', 'SUMMARY:Practice',
  ])), { now });
  assert.deepEqual(events.map((e) => e.startDate), ['2027-06-01', '2027-06-15', '2027-06-22']);
  assert.equal(new Set(events.map((e) => e.uid)).size, 3);
  const past = parseFeed(ICS(VEV(['UID:old', 'DTSTART;VALUE=DATE:20250101', 'SUMMARY:Old'])), { now });
  assert.equal(past.events.length, 0);
});

test('mixed feeds list each calendar so the family can pick', () => {
  const { calendars } = parseFeed(ICS(
    VEV(['UID:a', 'DTSTART;VALUE=DATE:20270610', 'SUMMARY:Game', 'CATEGORIES:Chesapeake Elite 2029'])
    + VEV(['UID:b', 'DTSTART;VALUE=DATE:20270611', 'SUMMARY:Soccer', 'CATEGORIES:Sam - U10 Soccer'])
    + VEV(['UID:c', 'DTSTART;VALUE=DATE:20270612', 'SUMMARY:Game 2', 'CATEGORIES:Chesapeake Elite 2029']),
  ), { now });
  assert.deepEqual(calendars.sort((x, y) => y.count - x.count), [{ name: 'Chesapeake Elite 2029', count: 2 }, { name: 'Sam - U10 Soccer', count: 1 }]);
  assert.throws(() => parseFeed('<html>login</html>'), /didn’t return a calendar/);
});

test('UID overlap matches two personal feeds of the same team', () => {
  assert.equal(uidOverlap(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'x']), 0.8);
  assert.equal(uidOverlap([], ['a']), 0);
});

test('date ranges overlap inclusively', () => {
  assert.ok(datesOverlap('2027-07-24', '2027-07-26', '2027-07-25', '2027-07-25'));
  assert.ok(datesOverlap('2027-07-24', '2027-07-24', '2027-07-24', null));
  assert.ok(!datesOverlap('2027-07-24', '2027-07-26', '2027-07-27', '2027-07-27'));
});

test('overlaps become one alert per plan event', () => {
  const plan = [
    { id: 'pe1', title: 'Northeast Elite Weekend', start: '2027-07-24', end: '2027-07-26', status: 'registered' },
    { id: 'pe2', title: 'Academic D3 Invitational', start: '2027-07-10', end: '2027-07-10', status: 'considering' },
    { id: 'pe3', title: 'Skipped camp', start: '2027-07-25', end: '2027-07-25', status: 'skipped' },
  ];
  const team = [
    { id: 'e1', teamId: 't', teamName: 'Chesapeake Elite', title: 'Game vs Express', startDate: '2027-07-25', endDate: '2027-07-25' },
    { id: 'e2', teamId: 't', teamName: 'Chesapeake Elite', title: 'Game vs Laxachusetts', startDate: '2027-07-26', endDate: '2027-07-26' },
    { id: 'e3', teamId: 't', title: 'Cancelled', startDate: '2027-07-10', endDate: '2027-07-10', cancelled: true },
  ];
  const o = findOverlaps(plan, team);
  assert.equal(o.length, 2);
  const alerts = overlapAlerts(o);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, 'overlap_pe1');
  assert.equal(alerts[0].title, 'Northeast Elite Weekend overlaps Chesapeake Elite: Game vs Express on Jul 25 and 1 more');
});

const { initializeApp, getApps } = require('../../functions/node_modules/firebase-admin/lib/app/index.js');
if (!getApps().length) initializeApp({ projectId: 'demo-laxhq', storageBucket: 'demo-laxhq.appspot.com' });
const { planExpense, cardSummer } = require('../../functions/schedule.js');
const { cleanReceipt } = require('../../functions/expenses.js');
const { isPrivateAddress } = require('../../functions/lib/net.js');

test('summer events become planned expenses, then spent when attended', () => {
  const ev = { title: 'Mid-Atlantic Showcase', kind: 'showcase', start: '2027-06-19', end: '2027-06-21', costEstimate: 1150, status: 'registered', location: { city: 'Bel Air', state: 'MD' } };
  assert.deepEqual(planExpense('jake', ev), {
    amountCents: 115000, date: '2027-06-19', season: '2026-27', category: 'tournaments', payee: 'Mid-Atlantic Showcase',
    note: 'Bel Air, MD', playerIds: ['jake'], status: 'planned', source: 'plan',
  });
  assert.equal(planExpense('jake', { ...ev, status: 'attended', actualCost: 980 }).amountCents, 98000);
  assert.equal(planExpense('jake', { ...ev, status: 'attended', actualCost: 980 }).status, 'spent');
  assert.equal(planExpense('jake', { ...ev, status: 'skipped' }), null);
  assert.equal(planExpense('jake', { ...ev, costEstimate: 0 }), null);
  assert.equal(planExpense('jake', null), null);
  assert.equal(planExpense('jake', { ...ev, kind: 'camp', start: '2027-09-02' }).season, '2027-28');
});

test('card summer line lists registered and attended events in order', () => {
  const y = new Date().getFullYear() + 1;
  assert.deepEqual(cardSummer([
    { start: `${y}-07-24`, status: 'registered', location: { city: 'Newport' } },
    { start: `${y}-06-19`, status: 'attended', location: { city: 'Bel Air' } },
    { start: `${y}-07-10`, status: 'considering', location: { city: 'Tarrytown' } },
    { start: `${y}-07-12`, status: 'registered', title: 'Academic D3 Invitational' },
  ]), ['Bel Air', 'Academic D3 Invitational', 'Newport']);
});

test('receipt answers are cleaned before they reach the form', () => {
  assert.deepEqual(cleanReceipt({ amount: '$1,412.36', date: '2026-11-08', payee: ' Hampton Inn ', category: 'hotels' }),
    { amount: '1412.36', date: '2026-11-08', payee: 'Hampton Inn', category: 'hotels' });
  assert.deepEqual(cleanReceipt({ amount: '', date: 'Nov 8', payee: '', category: 'unknown' }), { amount: null, date: null, payee: null, category: null });
});

test('private and metadata addresses are refused for feeds', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});
