import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withTiers, indexRow } from '../../scripts/seed-schools.mjs';
import { toAcademics, bestMatch } from '../../scripts/import-scorecard.mjs';

const { schools } = JSON.parse(readFileSync(new URL('../../data/schools.json', import.meta.url)));

test('starter catalog: unique ids, a state and at least one valid program each', () => {
  const ids = new Set();
  for (const s of schools) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`); ids.add(s.id);
    assert.match(s.state, /^[A-Z]{2}$/);
    const progs = Object.entries(s.programs);
    assert.ok(progs.length > 0, s.id);
    for (const [sport, p] of progs) {
      assert.ok(['mlax', 'wlax'].includes(sport));
      assert.ok(['D1', 'D2', 'D3'].includes(p.division));
      assert.ok(p.conference);
    }
  }
});

test('seeded programs get a default athletic tier; index rows are compact', () => {
  const s = withTiers(schools.find((x) => x.id === 'tufts-university'));
  assert.equal(s.programs.mlax.athleticTier, 4);
  assert.deepEqual(indexRow(s), ['tufts-university', 'Tufts University', 'Medford', 'MA', 'D3', 'D3', 'NESCAC', 'NESCAC']);
});

test('Scorecard rows map to academics and match by state and name', () => {
  const row = {
    id: 168148, 'school.name': 'Tufts University', 'school.state': 'MA',
    'latest.admissions.admission_rate.overall': 0.1,
    'latest.admissions.sat_scores.25th_percentile.critical_reading': 700, 'latest.admissions.sat_scores.25th_percentile.math': 720,
    'latest.admissions.sat_scores.75th_percentile.critical_reading': 760, 'latest.admissions.sat_scores.75th_percentile.math': 790,
    'latest.admissions.act_scores.25th_percentile.cumulative': 32, 'latest.admissions.act_scores.75th_percentile.cumulative': 35,
    'latest.student.size': 6000,
  };
  assert.deepEqual(toAcademics(row), { ipedsId: 168148, admitRate: 0.1, sat25: 1420, sat75: 1550, act25: 32, act75: 35, undergrad: 6000 });
  assert.equal(toAcademics({ id: 1 }).sat25, null);
  const other = { ...row, id: 2, 'school.name': 'Tufts Online', 'school.state': 'CA' };
  assert.equal(bestMatch([other, row], { name: 'Tufts University', state: 'MA' }).id, 168148);
  assert.equal(bestMatch([other], { name: 'Tufts University', state: 'MA' }), null);
  assert.equal(bestMatch([{ ...row, 'school.name': 'United States Military Academy', 'school.state': 'NY' }],
    { name: 'United States Military Academy (Army)', state: 'NY' })['school.state'], 'NY');
});
