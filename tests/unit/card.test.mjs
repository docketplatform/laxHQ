import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// functions/ has its own firebase-admin copy; initialize that one before loading card.js.
const { initializeApp, getApps } = require('../../functions/node_modules/firebase-admin/lib/app/index.js');
if (!getApps().length) initializeApp({ projectId: 'demo-laxhq' });
const { buildCard, applyView, applyVideoPlay, BOT_UA } = require('../../functions/card.js');

test('the card carries only shareable fields', () => {
  const c = buildCard({
    firstName: 'Jake', lastName: 'Morrison', sport: 'mlax', position: 'midfield', gradYear: 2029, jersey: '22',
    highSchool: { name: 'Severn Ridge HS', state: 'MD', ncesId: 'x' }, academics: { gpa: 3.7, sat: 1340 },
    club: { name: 'Chesapeake Elite', team: '2029', level: 'national' }, stats: { goals: 31, assists: null },
    rankings: [{ source: 'IL', value: '3 stars', url: null, selfReported: true }], filmUrl: 'https://hudl.com/x',
    cardStats: { views30d: 3 }, teamIds: ['t1'], createdBy: 'uid',
  }, { contactEmail: 'pat@example.com' });
  assert.equal(c.name, 'Jake Morrison');
  assert.equal(c.lastName, 'Morrison');
  assert.equal(c.gpa, 3.7);
  assert.equal(c.sat, undefined);
  assert.deepEqual(c.stats, { goals: 31 });
  assert.equal(c.cardStats, undefined);
  assert.equal(c.teamIds, undefined);
  assert.equal(c.highSchool.ncesId, undefined);
  assert.equal(c.contactEmail, 'pat@example.com');
});

test('views roll up into a 30-day count, total and recent schools', () => {
  const day = (d) => new Date(`2026-11-${String(d).padStart(2, '0')}T15:00:00Z`);
  let s = applyView({}, { now: day(1), schoolName: null });
  s = applyView(s, { now: day(2), schoolName: 'Tufts' });
  s = applyView(s, { now: day(2), schoolName: 'Lafayette' });
  s = applyView(s, { now: day(3), schoolName: 'Tufts' });
  assert.equal(s.total, 4);
  assert.equal(s.views30d, 4);
  assert.equal(s.tokenViews, 3);
  assert.deepEqual(s.recentSchools, ['Tufts', 'Lafayette']);
  const later = applyView(s, { now: new Date('2026-12-15T15:00:00Z'), schoolName: null });
  assert.equal(later.views30d, 1);
  assert.equal(later.total, 5);
});

test('link scanners and bots are recognized', () => {
  for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1)', 'Microsoft Office SafeLinks', 'Slackbot-LinkExpanding 1.0', 'curl/8.0', 'python-requests/2.31', 'HeadlessChrome/120'])
    assert.ok(BOT_UA.test(ua), ua);
  assert.ok(!BOT_UA.test('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'));
});

test('a family can show first name and last initial only', () => {
  const c = buildCard({ firstName: 'Jake', lastName: 'Morrison', cardNameStyle: 'initial', gradYear: 2029 });
  assert.equal(c.name, 'Jake M.');
  assert.equal(c.lastName, null);
  assert.equal(JSON.stringify(c).includes('Morrison'), false);
});

test('videos: the main reel first, then extra videos; events come from the plan', () => {
  const c = buildCard({
    firstName: 'Jake', lastName: 'Morrison', filmUrl: 'https://youtu.be/aaaaaaaaaaa',
    videos: [{ title: 'Full game vs Elite', url: 'https://vimeo.com/1', kind: 'game' }, { title: 'dupe', url: 'https://youtu.be/aaaaaaaaaaa', kind: 'highlight' }],
    cardEvents: [{ title: 'Summer Showcase', start: '2027-06-20', end: '2027-06-22', city: 'Baltimore', state: 'MD' }],
  });
  assert.deepEqual(c.videos.map((v) => v.title), ['Highlight reel', 'Full game vs Elite']);
  assert.equal(c.events[0].city, 'Baltimore');
  assert.deepEqual(buildCard({ firstName: 'A' }).videos, []);
});

test('video plays roll up by day and remember which school watched what', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  let st = applyVideoPlay({ views30d: 4 }, { now, schoolName: 'Duke University', title: 'Highlight reel' });
  st = applyVideoPlay(st, { now, schoolName: null, title: 'Full game' });
  assert.equal(st.views30d, 4, 'card views untouched');
  assert.equal(st.videoPlays, 2); assert.equal(st.videoPlays30d, 2);
  assert.deepEqual(st.recentVideoViews.map((r) => r.schoolName), [null, 'Duke University']);
  const later = applyVideoPlay(st, { now: new Date('2027-01-20T12:00:00Z'), title: 'x' });
  assert.equal(later.videoPlays30d, 1, 'old days drop out');
});
