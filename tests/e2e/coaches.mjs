// Phase 4 scenario: add a coach, AI draft, send from your own email, log a reply, alerts, commitment.
import assert from 'node:assert/strict';
import { BASE, SHOTS, launch, proFamilyWithPlayer, admin, uidFor } from './helpers.mjs';
import { startMockAnthropic } from '../mock-anthropic.mjs';

const mock = await startMockAnthropic(() => ({ json: {
  subject: 'Class of 2029 Midfield · Chesapeake Elite · Nate Silva',
  body: 'Coach Reyes,\n\nMy name is Nate Silva, a Class of 2029 midfielder.\n\nNate Silva',
} }));
const db = admin();
const run = await launch();
try {
  const page = await run.page('coaches');
  await proFamilyWithPlayer(page, 'morgan@example.com', 'Morgan Silva', {
    first: 'Nate', last: 'Silva', grad: '2029', pos: 'midfield', hs: 'Severn Ridge HS', state: 'MD', gpa: '3.6', club: 'Chesapeake Elite',
  });
  const fid = (await db.doc(`users/${await uidFor('morgan@example.com')}`).get()).get('familyId');
  const pid = (await db.collection(`families/${fid}/players`).get()).docs[0].id;
  const base = `families/${fid}/players/${pid}`;
  await db.doc(`${base}/targets/tufts-university`).set({ schoolId: 'tufts-university', name: 'Tufts University', sport: 'mlax', division: 'D3', conference: 'NESCAC', status: 'researching', priority: 2, school: { academics: null, athleticTier: 4 } });
  await db.doc(base).update({ targetCount: 1 });

  // Publish the card so drafts include a tracked link.
  await page.goto(`${BASE}#/profile`);
  await page.check('#card-publish');
  await page.getByText('Your card is live.').waitFor();

  await page.goto(`${BASE}#/coaches`);
  await page.getByText('Add your first coach').waitFor();
  assert.match(await page.locator('.banner.warn').innerText(), /can’t start recruiting conversations until Sept 1, 2027/);
  await page.click('text=Add a coach');
  await page.selectOption('#co-school', 'tufts-university');
  await page.fill('#co-name', 'Coach Reyes');
  await page.selectOption('#co-role', 'head');
  await page.fill('#co-email', 'reyes@tufts.edu');
  await page.click('#coach-form button[type=submit]');
  await page.getByRole('heading', { name: 'Coach Reyes' }).waitFor({ timeout: 15000 });

  // AI draft → edit → send from your own email → log it.
  await page.fill('#draft-note', 'Visited campus in October');
  await page.click('#write-draft');
  await page.locator('#draft-subject').waitFor({ timeout: 20000 });
  assert.match(await page.inputValue('#draft-subject'), /Class of 2029 Midfield/);
  const sent = mock.requests.at(-1).body;
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.match(sent.messages[0].content, /Visited campus in October/);
  assert.match(sent.messages[0].content, /Recruiting card link: http:\/\/127\.0\.0\.1:5000\/c\/[a-z2-9]{8}\?r=/);
  await page.fill('#draft-body', 'Coach Reyes,\n\nEdited by Nate.\n\nNate Silva');
  const mailto = await page.getAttribute('#open-mail', 'href');
  assert.match(mailto, /^mailto:reyes@tufts\.edu\?subject=Class%20of%202029/);
  assert.match(decodeURIComponent(mailto), /Edited by Nate/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/11-draft.png`, fullPage: true });
  await page.click('#mark-sent');
  await page.getByText('Logged. LaxHQ will remind you').waitFor();
  await page.locator('.chip', { hasText: 'Emailed' }).first().waitFor();
  await page.locator('.list b', { hasText: 'Email sent' }).first().waitFor();

  // Tracked link for this coach.
  await page.click('#card-link-btn');
  await page.locator('#tracked-link').waitFor();
  assert.match(await page.inputValue('#tracked-link'), /\/c\/[a-z2-9]{8}\?r=[A-Za-z2-9]{12}$/);

  // The coach replies.
  await page.selectOption('#tt-type', 'reply_in');
  await page.fill('#tt-note', 'Asked for summer schedule');
  await page.click('#touch-form button[type=submit]');
  await page.locator('.list b', { hasText: 'Coach replied' }).first().waitFor();
  await page.goto(`${BASE}#/coaches`);
  await page.locator('#pipeline', { hasText: /1\s*Replied/ }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/12-pipeline.png`, fullPage: true });

  // A follow-up alert shows on Home and can be dismissed.
  const contactId = (await db.collection(`${base}/contacts`).get()).docs[0].id;
  await db.doc(`${base}/alerts/followup_test`).set({ type: 'followup_due', severity: 'info', refs: { contactId }, title: 'Follow up with Coach Reyes at Tufts University', dismissedAt: null, createdAt: new Date() });
  await page.goto(`${BASE}#/home`);
  await page.getByText('Follow up with Coach Reyes at Tufts University').waitFor({ timeout: 10000 });
  await page.click('[data-dismiss="followup_test"]');
  await page.getByText('Follow up with Coach Reyes at Tufts University').waitFor({ state: 'detached', timeout: 10000 });

  // Commitment: share the GPA anonymously.
  await page.goto(`${BASE}#/schools/tufts-university`);
  await page.selectOption('#t-status', 'committed');
  await page.click('#target-form button[type=submit]');
  await page.getByText('Congratulations!').waitFor();
  await page.click('[data-outcome="share"]');
  await page.getByText('Thanks for sharing.').waitFor();
  const outcome = await db.doc(`outcomes/${fid}_${pid}`).get();
  assert.equal(outcome.get('shareForStats'), true);
  assert.equal(outcome.get('gpa'), 3.6);

  assert.deepEqual(run.errors, [], run.errors.join('; '));
  console.log('e2e coaches: add coach, AI draft, compose link, mark sent, tracked link, reply, alerts, commitment ✔');
} finally {
  await run.close();
  await mock.close();
}
