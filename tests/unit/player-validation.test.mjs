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
