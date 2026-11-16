import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan, contactOpensDate, currentGrade, gradeLabel, seasonKey, daysBetween, ymd, gradYearOptions, isoDate,
} from '../../web/lib/plan.js';
import { checklist } from '../../scripts/seed-config.mjs';

const today = ymd(2026, 11, 16);
const jake = { gradYear: 2029, sport: 'mlax', position: 'midfield', openDivisions: ['D1', 'D3'] };

test('contact opens Sept 1 of junior year', () => {
  assert.equal(isoDate(contactOpensDate(2029)), '2027-09-01');
  assert.equal(daysBetween(today, contactOpensDate(2029)), 289);
});

test('grades follow the school year (turns over Aug 1)', () => {
  assert.equal(currentGrade(2029, today), 10);
  assert.equal(currentGrade(2029, ymd(2027, 7, 31)), 10);
  assert.equal(currentGrade(2029, ymd(2027, 8, 1)), 11);
  assert.equal(gradeLabel(currentGrade(2032, today)), 'Middle school');
  assert.equal(gradeLabel(12), 'Senior');
});

test('season key runs Sept 1 to Aug 31', () => {
  assert.equal(seasonKey(ymd(2026, 11, 16)), '2026-27');
  assert.equal(seasonKey(ymd(2027, 8, 31)), '2026-27');
  assert.equal(seasonKey(ymd(2027, 9, 1)), '2027-28');
});

test('grad year options start with this school year’s seniors', () => {
  assert.deepEqual(gradYearOptions(today), [2027, 2028, 2029, 2030, 2031, 2032, 2033]);
});

test('buildPlan dates every template item and sorts by due date', () => {
  const plan = buildPlan(checklist, jake, {}, today);
  assert.equal(plan.items.length, checklist.items.length);
  assert.equal(plan.daysToContact, 289);
  assert.equal(plan.grade, 10);
  for (let i = 1; i < plan.items.length; i++) assert.ok(plan.items[i - 1].due <= plan.items[i].due);
  const reel = plan.items.find((i) => i.id === 'soph-reel');
  assert.equal(isoDate(reel.start), '2026-10-06'); // contactOpens - 330 days
  assert.equal(reel.status, 'current');
});

test('statuses: done, skipped, overdue, current, upcoming', () => {
  const state = { done: { 'soph-reel': Date.now() }, skipped: { 'test-plan': Date.now() } };
  const plan = buildPlan(checklist, jake, state, today);
  const by = Object.fromEntries(plan.items.map((i) => [i.id, i.status]));
  assert.equal(by['soph-reel'], 'done');
  assert.equal(by['test-plan'], 'skipped');
  assert.equal(by['profile-basics'], 'overdue');
  assert.equal(by['transcript-fall-10'], 'current');
  assert.equal(by['sept1-ready'], 'upcoming');
});

test('readiness counts only steps whose window has opened', () => {
  const none = buildPlan(checklist, jake, {}, today);
  assert.equal(none.readiness, 0);
  assert.ok(none.dueSoFar > 0);
  const allOpenDone = Object.fromEntries(none.items.filter((i) => i.start <= today).map((i) => [i.id, 1]));
  const full = buildPlan(checklist, jake, { done: allOpenDone }, today);
  assert.equal(full.readiness, 100);
});

test('thisWeek lists open items first, at most 5', () => {
  const plan = buildPlan(checklist, jake, {}, today);
  assert.ok(plan.thisWeek.length > 0 && plan.thisWeek.length <= 6);
  assert.ok(plan.thisWeek.slice(0, 5).every((i) => ['overdue', 'current'].includes(i.status)));
});

test('appliesTo filters by sport, position and division', () => {
  const template = { items: [
    { id: 'all', window: { anchor: 'contactOpens', startDays: 0, dueDays: 1 } },
    { id: 'goalie', appliesTo: { positions: ['goalie'] }, window: { anchor: 'contactOpens', startDays: 0, dueDays: 1 } },
    { id: 'wlax', appliesTo: { sports: ['wlax'] }, window: { anchor: 'contactOpens', startDays: 0, dueDays: 1 } },
    { id: 'd2', appliesTo: { divisions: ['D2'] }, window: { anchor: 'contactOpens', startDays: 0, dueDays: 1 } },
    { id: 'd1', appliesTo: { divisions: ['D1', 'D2'] }, window: { anchor: 'afterSophomore', startDays: 0, dueDays: 1 } },
  ] };
  const ids = buildPlan(template, jake, {}, today).items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['all', 'd1']);
});

test('custom tasks appear with their due date and never count toward readiness', () => {
  const plan = buildPlan(checklist, jake, { custom: { c1: { title: 'Call Coach Reyes', due: '2026-11-20' } } }, today);
  const c = plan.items.find((i) => i.id === 'c1');
  assert.equal(c.custom, true);
  assert.equal(c.status, 'current');
  assert.ok(plan.thisWeek.some((i) => i.id === 'c1'));
});

test('a player without a grad year is rejected', () => {
  assert.throws(() => buildPlan(checklist, {}, {}, today), /gradYear/);
});

test('freshman steps fall in freshman year', () => {
  const plan = buildPlan(checklist, jake, {}, today);
  const basics = plan.items.find((i) => i.id === 'profile-basics');
  assert.equal(isoDate(basics.start), '2025-09-01'); // Jake's freshman year started Sept 2025
  assert.ok(plan.items.filter((i) => i.grade === 9).every((i) => i.start >= ymd(2025, 8, 1) && i.due <= ymd(2026, 8, 31)));
});

test('the profile step ticks itself once school, GPA and club are filled in', () => {
  const filled = { ...jake, highSchool: { name: 'Severn Ridge HS' }, academics: { gpa: 3.7 }, club: { name: 'Chesapeake Elite' } };
  const item = buildPlan(checklist, filled, {}, today).items.find((i) => i.id === 'profile-basics');
  assert.equal(item.status, 'done');
  assert.equal(item.auto, true);
  assert.equal(buildPlan(checklist, jake, {}, today).items.find((i) => i.id === 'profile-basics').status, 'overdue');
});
