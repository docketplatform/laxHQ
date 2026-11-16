import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initializeApp, getApps } = require('../../functions/node_modules/firebase-admin/lib/app/index.js');
if (!getApps().length) initializeApp({ projectId: 'demo-laxhq' });
const { draftFacts, committedStats, suggestionId, DRAFT_SCHEMA } = require('../../functions/coaches.js');

const player = {
  firstName: 'Jake', lastName: 'Morrison', gradYear: 2029, position: 'midfield', jersey: '22',
  highSchool: { name: 'Severn Ridge HS', state: 'MD' }, club: { name: 'Chesapeake Elite', team: '2029' },
  academics: { gpa: 3.7, gpaScale: 4 }, stats: { season: '2026 HS', goals: 31, assists: null },
};

test('draft facts include only what the family entered', () => {
  const f = draftFacts({
    player, contact: { name: 'Coach Reyes', role: 'head', schoolName: 'Tufts University' }, target: { notes: 'Loved the engineering program.' },
    plan: [{ title: 'Mid-Atlantic Showcase', dates: 'Jun 19–21', place: 'Bel Air, MD' }], cardUrl: 'https://app/c/abc?r=t1',
    parentEmail: 'pat@example.com', kind: 'intro', lastEmailAt: null, note: null,
  });
  assert.match(f, /Email type: first email/);
  assert.match(f, /Jake Morrison, Class of 2029, midfield, #22/);
  assert.match(f, /GPA: 3\.7/);
  assert.match(f, /Stats \(2026 HS\): goals: 31/);
  assert.doesNotMatch(f, /assists/);
  assert.match(f, /Mid-Atlantic Showcase \(Jun 19–21, Bel Air, MD\)/);
  assert.match(f, /Recruiting card link: https:\/\/app\/c\/abc\?r=t1/);
  assert.match(f, /Loved the engineering program/);
  assert.doesNotMatch(f, /SAT|ACT|Earlier email/);
});

test('follow-up facts mention the earlier email', () => {
  const f = draftFacts({ player, contact: {}, target: null, plan: [], cardUrl: null, parentEmail: null, kind: 'followup', lastEmailAt: 'Oct 2', note: 'New film from fall ball' });
  assert.match(f, /follow-up/);
  assert.match(f, /Earlier email sent: Oct 2/);
  assert.match(f, /New film from fall ball/);
});

test('the draft schema is strict JSON with subject and body', () => {
  assert.deepEqual(DRAFT_SCHEMA.required, ['subject', 'body']);
  assert.equal(DRAFT_SCHEMA.additionalProperties, false);
});

test('committed averages need 5 reports', () => {
  assert.equal(committedStats([3.5, 3.6, 3.7, 3.8]), null);
  assert.deepEqual(committedStats([3.5, 3.6, 3.7, 3.8, 3.4]), { count: 5, avgGpa: 3.6 });
  assert.equal(committedStats([3.5, null, 3.6, 3.7, 3.8]), null);
});

test('the same coach email at the same program maps to one suggestion', () => {
  assert.equal(suggestionId('tufts-university', 'mlax', ' Coach@Tufts.edu '), suggestionId('tufts-university', 'mlax', 'coach@tufts.edu'));
  assert.notEqual(suggestionId('tufts-university', 'mlax', 'a@b.c'), suggestionId('tufts-university', 'wlax', 'a@b.c'));
});
