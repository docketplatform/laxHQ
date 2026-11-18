import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validatePlayer } = require('../../functions/lib/player.js');
const now = new Date(2026, 10, 16);
const base = { firstName: 'Jake', lastName: 'Morrison', sport: 'mlax', gradYear: 2029, position: 'midfield', openDivisions: ['D3', 'D1', 'D1'] };

test('a complete profile is cleaned and normalized', () => {
  const out = validatePlayer({
    ...base, firstName: '  Jake  ', jersey: '22',
    highSchool: { name: 'Severn Ridge HS', state: 'MD' },
    academics: { gpa: '3.7', sat: 1340 },
    club: { name: 'Chesapeake Elite', team: '2029', level: 'national' },
    rankings: [{ source: 'Inside Lacrosse', value: '3 stars', url: 'https://example.com/p/1' }],
    stats: { season: '2026 HS', goals: 31, assists: 18, faceoffPct: 55 },
    filmUrl: 'https://www.hudl.com/video/abc',
  }, { now });
  assert.equal(out.firstName, 'Jake');
  assert.deepEqual(out.openDivisions, ['D1', 'D3']);
  assert.equal(out.academics.gpa, 3.7);
  assert.equal(out.academics.gpaScale, 4);
  assert.equal(out.rankings[0].selfReported, true);
  assert.equal(out.stats.goals, 31);
});

test('required fields and ranges are enforced', () => {
  assert.throws(() => validatePlayer({ ...base, firstName: ' ' }, { now }), /First name is required/);
  assert.throws(() => validatePlayer({ ...base, sport: 'hockey' }, { now }), /Sport is not valid/);
  assert.throws(() => validatePlayer({ ...base, gradYear: 2026 }, { now }), /Grad year must be between 2027 and 2033/);
  assert.throws(() => validatePlayer({ ...base, openDivisions: ['NAIA'] }, { now }), /at least one division/);
  assert.throws(() => validatePlayer({ ...base, academics: { gpa: 4.3 } }, { now }), /GPA must be between 0 and 4/);
  assert.doesNotThrow(() => validatePlayer({ ...base, academics: { gpa: 4.3, gpaScale: 5, weighted: true } }, { now }));
  assert.throws(() => validatePlayer({ ...base, academics: { sat: 1700 } }, { now }), /SAT/);
  assert.throws(() => validatePlayer({ ...base, filmUrl: 'javascript:alert(1)' }, { now }), /web link/);
  assert.throws(() => validatePlayer({ ...base, highSchool: { state: 'ZZ' } }, { now }), /state is not valid/);
});

test('partial updates only validate the fields sent', () => {
  assert.deepEqual(validatePlayer({ jersey: '7' }, { now, partial: true }), { jersey: '7' });
  assert.throws(() => validatePlayer({ position: 'striker' }, { now, partial: true }), /Position/);
});

test('videos: up to 8, each needs a link, unknown types become other', () => {
  const out = validatePlayer({ ...base, videos: [{ title: 'Game', url: 'https://vimeo.com/1', kind: 'game' }, { url: 'https://youtu.be/x', kind: 'weird' }, {}] });
  assert.deepEqual(out.videos, [{ title: 'Game', url: 'https://vimeo.com/1', kind: 'game', date: null }, { title: null, url: 'https://youtu.be/x', kind: 'other', date: null }]);
  assert.equal(validatePlayer({ ...base, videos: [{ url: 'https://youtu.be/x', date: '2026-07' }] }).videos[0].date, '2026-07');
  assert.equal(validatePlayer({ ...base, videos: [{ url: 'https://youtu.be/x', date: 'July' }] }).videos[0].date, null);
  assert.throws(() => validatePlayer({ ...base, videos: [{ title: 'No link' }] }), /link for video 1/);
  assert.throws(() => validatePlayer({ ...base, videos: [{ url: 'javascript:alert(1)' }] }), /web link|https/);
  assert.equal(validatePlayer({ ...base, videos: Array.from({ length: 12 }, (_, i) => ({ url: `https://youtu.be/v${i}` })) }).videos.length, 8);
});

test('card profile: positions, height, hand, hometown, statement, honors, social, jerseys', () => {
  const out = validatePlayer({
    ...base, position: 'attack', otherPositions: ['midfield', 'attack', 'midfield', 'nope'], heightIn: '66', hand: 'R',
    hometown: { city: 'Maplewood', state: 'NJ' }, statement: '  Two-way player.  \n\n\n\nVarsity starter. ', honors: ['All-Conference', '', 'Team MVP'],
    social: { x: '@jake_m', instagram: 'https://www.instagram.com/jake.m/' }, highSchool: { name: 'CHS', jersey: '13' }, club: { name: 'BBL', jersey: '7' },
    academics: { gpa: 3.9, showTests: true, sat: 1400 },
  });
  assert.deepEqual(out.otherPositions, ['midfield']);
  assert.equal(out.heightIn, 66); assert.equal(out.hand, 'R');
  assert.equal(out.statement, 'Two-way player.\n\nVarsity starter.');
  assert.deepEqual(out.honors, ['All-Conference', 'Team MVP']);
  assert.deepEqual(out.social, { x: 'jake_m', instagram: 'jake.m' });
  assert.equal(out.highSchool.jersey, '13'); assert.equal(out.club.jersey, '7'); assert.equal(out.academics.showTests, true);
  assert.throws(() => validatePlayer({ ...base, heightIn: 120 }), /Height/);
  assert.throws(() => validatePlayer({ ...base, hand: 'X' }), /hand/);
  assert.throws(() => validatePlayer({ ...base, social: { x: 'not a handle!' } }), /@name/);
  assert.throws(() => validatePlayer({ ...base, statement: 'x'.repeat(1600) }), /too long/);
});
