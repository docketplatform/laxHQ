import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  academicFit, athleticLevel, athleticFit, overallTier, targetFit, listBalance, normalizeGpa, defaultAthleticTier,
} from '../../web/lib/fit.js';

const school = (o = {}) => ({ academics: { avgHsGpa: 3.6, admitRate: 0.4, ...o } });

test('GPA against the admitted average', () => {
  assert.equal(academicFit({ academics: { gpa: 3.2 } }, school().academics).fit, 'reach');
  assert.equal(academicFit({ academics: { gpa: 3.7 } }, school().academics).fit, 'target');
  assert.equal(academicFit({ academics: { gpa: 3.9 } }, school().academics).fit, 'likely');
  assert.match(academicFit({ academics: { gpa: 3.7 } }, school().academics).basis, /GPA 3.7 vs. admitted average 3.6/);
});

test('test scores win over GPA when both school and player have them', () => {
  const ac = { avgHsGpa: 3.9, sat25: 1300, sat75: 1450, admitRate: 0.5 };
  assert.equal(academicFit({ academics: { gpa: 3.0, sat: 1500 } }, ac).fit, 'likely');
  assert.equal(academicFit({ academics: { gpa: 4.0, sat: 1200 } }, ac).fit, 'reach');
  assert.equal(academicFit({ academics: { act: 31 } }, { act25: 29, act75: 33 }).fit, 'target');
});

test('very selective schools are never likely, and GPA alone makes them a reach', () => {
  const ivy = { avgHsGpa: 3.9, admitRate: 0.06, sat25: 1480, sat75: 1560 };
  assert.equal(academicFit({ academics: { sat: 1590 } }, ivy).fit, 'target');
  assert.equal(academicFit({ academics: { gpa: 3.95 } }, { avgHsGpa: 3.9, admitRate: 0.06 }).fit, 'reach');
});

test('missing data gives no academic fit', () => {
  assert.equal(academicFit({ academics: {} }, school().academics).fit, null);
  assert.equal(academicFit({ academics: { gpa: 3.7 } }, {}).fit, null);
  assert.equal(academicFit({}, undefined).fit, null);
});

test('weighted 5.0 GPAs are scaled to 4.0', () => {
  assert.equal(normalizeGpa(4.5, 5, true), 3.6);
  assert.equal(normalizeGpa(4.3, 4, true), 4);
  assert.equal(normalizeGpa(3.7, 4, false), 3.7);
});

test('athletic level from club level, honors and rankings', () => {
  assert.equal(athleticLevel({}), null);
  assert.equal(athleticLevel({ club: { level: 'local' } }), 1);
  assert.equal(athleticLevel({ club: { level: 'national' } }), 3);
  assert.equal(athleticLevel({ club: { level: 'national' }, athletic: { varsityStarter: true, allConference: true }, rankings: [{}] }), 5);
});

test('athletic fit compares level to the program tier', () => {
  const national = { club: { level: 'national' } }; // level 3
  assert.equal(athleticFit(national, 1).fit, 'reach');   // needs 5
  assert.equal(athleticFit(national, 3).fit, 'target');  // needs 3
  assert.equal(athleticFit(national, 5).fit, 'likely');  // needs 1
  assert.equal(athleticFit({}, 3).fit, null);
});

test('overall tier is the harder of the two fits', () => {
  assert.equal(overallTier('likely', 'reach'), 'reach');
  assert.equal(overallTier('target', null), 'target');
  assert.equal(overallTier(null, null), null);
});

test('targetFit honors a family override', () => {
  const p = { academics: { gpa: 3.9 }, club: { level: 'national' } };
  const t = { school: { academics: { avgHsGpa: 3.6, admitRate: 0.4 }, athleticTier: 3 } };
  assert.equal(targetFit(p, t).tier, 'target');
  const o = targetFit(p, { ...t, tierOverride: 'reach' });
  assert.equal(o.tier, 'reach');
  assert.equal(o.computed, 'target');
  assert.equal(o.overridden, true);
});

test('list balance flags top-heavy lists and lists with no likely schools', () => {
  assert.equal(listBalance(['reach', 'reach', 'reach', 'target', 'likely']).warning?.startsWith('Top-heavy'), true);
  assert.match(listBalance(['reach', 'target', 'target', 'target', 'target']).warning, /No likely/);
  assert.equal(listBalance(['reach', 'reach', 'reach', 'target', 'target', 'target', 'target', 'target', 'target', 'target', 'likely', 'likely', 'likely', 'likely']).warning, null);
  assert.deepEqual(listBalance(['reach', null]).counts, { reach: 1, target: 0, likely: 0, unrated: 1 });
  assert.equal(listBalance(['reach', 'reach']).warning, null); // too few to judge
});

test('default athletic tier from division and conference', () => {
  assert.equal(defaultAthleticTier('D1', 'Big Ten'), 1);
  assert.equal(defaultAthleticTier('D1', 'Patriot League'), 3);
  assert.equal(defaultAthleticTier('D3', 'NESCAC'), 4);
  assert.equal(defaultAthleticTier('D3', 'ODAC'), 5);
});
