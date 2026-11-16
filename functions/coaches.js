// Coach outreach (Phase 4): AI-drafted emails, tracked card links, the family-built coach
// directory, commitment reports for school averages, and daily follow-up nudges.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('node:crypto');
const AnthropicSDK = require('@anthropic-ai/sdk');

const Anthropic = AnthropicSDK.default || AnthropicSDK;
const db = getFirestore();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const MODEL = 'claude-opus-5-5';
const COMMITTED_MIN_REPORTS = 5;

// ---------- shared helpers (passed in from index.js to avoid circular requires) ----------
let helpers = null;
function init(h) { helpers = h; }

function randomToken(len = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

const monthKey = (d = new Date()) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const normEmail = (e) => String(e || '').trim().toLowerCase();
const suggestionId = (schoolId, sport, email) => crypto.createHash('sha1').update(`${schoolId}|${sport}|${normEmail(email)}`).digest('hex').slice(0, 24);

async function loadContact(fid, playerId, contactId) {
  if (typeof playerId !== 'string' || typeof contactId !== 'string' || !playerId || !contactId) {
    throw new HttpsError('invalid-argument', 'playerId and contactId are required.');
  }
  const playerRef = db.doc(`families/${fid}/players/${playerId}`);
  const contactRef = playerRef.collection('contacts').doc(contactId);
  const [player, contact] = await Promise.all([playerRef.get(), contactRef.get()]);
  if (!player.exists || !contact.exists) throw new HttpsError('not-found', 'That coach was not found.');
  return { playerRef, contactRef, player: player.data(), contact: contact.data() };
}

/** Per-coach card token, created on first use. */
async function ensureCardToken(fid, playerId, contactRef, contact) {
  if (contact.cardToken) return contact.cardToken;
  const token = randomToken(12);
  await db.doc(`cardTokens/${token}`).create({
    fid, pid: playerId, contactId: contactRef.id, schoolName: contact.schoolName || null, createdAt: FieldValue.serverTimestamp(),
  });
  await contactRef.update({ cardToken: token });
  return token;
}

function checkOrigin(origin) {
  try {
    const u = new URL(String(origin || ''));
    if (!['https:', 'http:'].includes(u.protocol)) throw new Error();
    return u.origin;
  } catch { throw new HttpsError('invalid-argument', 'appOrigin must be the app’s web address.'); }
}

/** contactCardLink — the tracked card link for one coach. data: { playerId, contactId, appOrigin } */
const contactCardLink = onCall(async (req) => {
  const { fid } = await helpers.requireProFamily(req);
  const { playerId, contactId, appOrigin } = req.data || {};
  const origin = checkOrigin(appOrigin);
  const { contactRef, contact, player } = await loadContact(fid, playerId, contactId);
  if (!player.cardPublished) throw new HttpsError('failed-precondition', 'Turn on sharing for the recruiting card on the Profile tab first.');
  const token = await ensureCardToken(fid, playerId, contactRef, contact);
  return { url: `${origin}/c/${player.cardSlug}?r=${token}` };
});

// ---------- AI drafts ----------

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Email subject line, under 80 characters.' },
    body: { type: 'string', description: 'Plain-text email body with line breaks, signed by the player.' },
  },
  required: ['subject', 'body'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You draft emails from high school lacrosse players to college lacrosse coaches. The family reviews every draft and sends it from their own email account.

How the email should read:
- Written by the player, in the first person, in a plain and confident voice. Short sentences. No flattery, slang or exclamation points.
- 120 to 180 words for a first email; 60 to 120 for a follow-up.
- Open with who the player is: name, grad year, position, high school and club team.
- Give one or two concrete details coaches use: GPA, a key stat, and the summer events where the coach can see the player play, with dates.
- Say why this school, only if the facts include a reason. Never make one up.
- Include the recruiting card link exactly once, on its own line, if one is provided.
- End with a simple next step (for example, asking which events the staff will attend) and sign with the player's full name, grad year, position, and the parent's email if provided.
- For a follow-up, refer to the earlier email by its date and add something new (new stats, film, an updated schedule).

Rules:
- Use only the facts provided. If a fact is missing, leave it out; never invent stats, rankings, events, dates or reasons.
- Don't mention NCAA rules, contact dates or that coaches may not be able to reply.
- Subject line: "Class of <year> <position> · <club or high school> · <name>" for a first email, or a short follow-up subject.`;

/** Facts for the model, from the player's profile and the contact. Pure; tested. */
function draftFacts({ player, contact, target, plan, cardUrl, parentEmail, kind, lastEmailAt, note }) {
  const pa = player.academics || {};
  const stats = Object.entries(player.stats || {}).filter(([k, v]) => k !== 'season' && v != null).map(([k, v]) => `${k}: ${v}`);
  const lines = [
    `Email type: ${kind === 'followup' ? 'follow-up' : 'first email'}`,
    `Coach: ${contact.name || 'Coach'} (${contact.role || 'coach'}) at ${contact.schoolName || 'the school'}`,
    `Player: ${player.firstName} ${player.lastName}, Class of ${player.gradYear}, ${player.position}${player.jersey ? `, #${player.jersey}` : ''}`,
    player.highSchool?.name ? `High school: ${player.highSchool.name}${player.highSchool.state ? `, ${player.highSchool.state}` : ''}` : null,
    player.club?.name ? `Club: ${player.club.name}${player.club.team ? ` ${player.club.team}` : ''}` : null,
    pa.gpa != null ? `GPA: ${pa.gpa}${pa.gpaScale === 5 ? ' (5.0 scale)' : ''}${pa.weighted ? ' weighted' : ''}` : null,
    pa.sat ? `SAT: ${pa.sat}` : null,
    pa.act ? `ACT: ${pa.act}` : null,
    stats.length ? `Stats${player.stats?.season ? ` (${player.stats.season})` : ''}: ${stats.join(', ')}` : null,
    player.filmUrl ? `Highlight film: ${player.filmUrl}` : null,
    plan.length ? `Upcoming events: ${plan.map((e) => `${e.title} (${e.dates}${e.place ? `, ${e.place}` : ''})`).join('; ')}` : null,
    target?.notes ? `Family's notes on this school: ${String(target.notes).slice(0, 600)}` : null,
    cardUrl ? `Recruiting card link: ${cardUrl}` : null,
    parentEmail ? `Parent email: ${parentEmail}` : null,
    kind === 'followup' && lastEmailAt ? `Earlier email sent: ${lastEmailAt}` : null,
    note ? `Anything else to include: ${String(note).slice(0, 400)}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * aiDraftEmail — draft an email to one coach. Counts against the family's monthly quota.
 * data: { playerId, contactId, kind: 'intro'|'followup', note?, appOrigin }
 * returns: { subject, body, remaining }
 */
const aiDraftEmail = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120 }, async (req) => {
  const { uid, fid } = await helpers.requireProFamily(req);
  const { playerId, contactId, note } = req.data || {};
  const kind = req.data?.kind === 'followup' ? 'followup' : 'intro';
  const origin = checkOrigin(req.data?.appOrigin);
  const { player, contact, contactRef } = await loadContact(fid, playerId, contactId);

  // Quota: reserve one draft before calling the model; give it back on failure.
  const plans = (await db.doc('config/plans').get()).data() || {};
  const limit = plans.pro?.aiDraftsPerMonth ?? 60;
  const usageRef = db.doc(`usage/${fid}_${monthKey()}`);
  const used = await db.runTransaction(async (tx) => {
    const u = await tx.get(usageRef);
    const n = (u.exists && u.get('aiDrafts')) || 0;
    if (n >= limit) throw new HttpsError('resource-exhausted', `You’ve used all ${limit} AI drafts this month. They reset on the 1st.`);
    tx.set(usageRef, { aiDrafts: n + 1, fid, month: monthKey() }, { merge: true });
    return n + 1;
  });

  try {
    const [targetSnap, planSnap, userSnap, lastEmail] = await Promise.all([
      contact.schoolId ? db.doc(`families/${fid}/players/${playerId}/targets/${contact.schoolId}`).get() : null,
      db.collection(`families/${fid}/players/${playerId}/plan`).where('start', '>=', new Date().toISOString().slice(0, 10)).orderBy('start').limit(4).get(),
      db.doc(`users/${uid}`).get(),
      db.collection(`families/${fid}/players/${playerId}/touches`).where('contactId', '==', contactId).where('type', '==', 'email_out').orderBy('at', 'desc').limit(1).get(),
    ]);
    const plan = planSnap.docs.map((d) => d.data()).filter((e) => e.status !== 'skipped').map((e) => ({
      title: e.title, place: [e.location?.city, e.location?.state].filter(Boolean).join(', '),
      dates: e.end && e.end !== e.start ? `${fmt(new Date(e.start))}–${fmt(new Date(e.end))}` : fmt(new Date(e.start)),
    }));
    const cardUrl = player.cardPublished ? `${origin}/c/${player.cardSlug}?r=${await ensureCardToken(fid, playerId, contactRef, contact)}` : null;
    const last = lastEmail.docs[0]?.get('at');
    const facts = draftFacts({
      player, contact, target: targetSnap?.exists ? targetSnap.data() : null, plan, cardUrl,
      parentEmail: userSnap.get('role') === 'parent' ? userSnap.get('email') : null,
      kind, lastEmailAt: last ? fmt(last.toDate()) : null, note,
    });

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Draft the email from these facts.\n\n${facts}` }],
    });
    if (response.stop_reason === 'refusal') {
      throw new HttpsError('failed-precondition', 'LaxHQ couldn’t draft this email. Try adding a note, or write it yourself.');
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let draft;
    try { draft = JSON.parse(text); } catch { throw new HttpsError('internal', 'The draft came back incomplete. Try again.'); }
    if (!draft.subject || !draft.body) throw new HttpsError('internal', 'The draft came back incomplete. Try again.');
    return { subject: String(draft.subject).slice(0, 200), body: String(draft.body).slice(0, 5000), remaining: Math.max(0, limit - used) };
  } catch (e) {
    await usageRef.set({ aiDrafts: FieldValue.increment(-1) }, { merge: true }).catch(() => {});
    if (e instanceof HttpsError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new HttpsError('resource-exhausted', 'The AI service is busy. Try again in a minute.');
    if (e instanceof Anthropic.APIError) throw new HttpsError('unavailable', 'The AI service is unavailable right now. Try again shortly.');
    throw e;
  }
});

// ---------- coach directory ----------

/**
 * When a family saves a coach with an email at a catalog school, record it as a suggestion.
 * Two families entering the same email, or one logged reply, promotes it to coaches/{id}.
 */
const onContactWrite = onDocumentWritten('families/{fid}/players/{pid}/contacts/{cid}', async (event) => {
  const { fid, pid, cid } = event.params;
  const after = event.data.after.exists ? event.data.after.data() : null;
  const before = event.data.before.exists ? event.data.before.data() : null;
  if (!after || !after.email || !after.schoolId || after.schoolId.startsWith('custom-')) return;
  const relevant = (c) => c && JSON.stringify([normEmail(c.email), c.schoolId, c.name, c.role, Boolean(c.lastReplyAt)]);
  if (before && relevant(before) === relevant(after)) return; // e.g. only coachId/stats changed

  const player = await db.doc(`families/${fid}/players/${pid}`).get();
  const sport = player.get('sport');
  if (!sport) return;
  const id = suggestionId(after.schoolId, sport, after.email);
  const sugRef = db.doc(`coachSuggestions/${id}`);
  const coachRef = db.doc(`coaches/${id}`);

  await db.runTransaction(async (tx) => {
    const [sug, coach] = await Promise.all([tx.get(sugRef), tx.get(coachRef)]);
    const fids = new Set(sug.exists ? sug.get('fids') : []);
    const replyFids = new Set(sug.exists ? sug.get('replyFids') : []);
    fids.add(fid);
    if (after.lastReplyAt) replyFids.add(fid);
    tx.set(sugRef, {
      schoolId: after.schoolId, sport, email: normEmail(after.email), name: after.name || null, role: after.role || null,
      fids: [...fids], replyFids: [...replyFids], updatedAt: FieldValue.serverTimestamp(),
      ...(sug.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });

    if (fids.size >= 2 || replyFids.size >= 1) {
      const suppressed = coach.exists && coach.get('status') === 'suppressed';
      tx.set(coachRef, {
        schoolId: after.schoolId, sport, name: after.name || (coach.exists ? coach.get('name') : null) || null, role: after.role || null,
        email: normEmail(after.email), sourceType: 'family', sourceUrl: null,
        status: suppressed && replyFids.size === 0 ? 'suppressed' : 'active',
        confirmations: fids.size, replyConfirmed: replyFids.size > 0,
        lastVerifiedAt: FieldValue.serverTimestamp(), lastSeenAt: FieldValue.serverTimestamp(),
        ...(coach.exists ? {} : { firstSeenAt: FieldValue.serverTimestamp(), reports: 0 }),
      }, { merge: true });
    }
  });
  if (!after.coachId && (await coachRef.get()).exists) {
    await db.doc(`families/${fid}/players/${pid}/contacts/${cid}`).update({ coachId: id });
  }
});

/** reportCoach — "wrong email" or a bounce. Two families reporting, or one bounce, hides the email. */
const reportCoach = onCall(async (req) => {
  const { fid } = await helpers.requireProFamily(req);
  const { coachId, reason } = req.data || {};
  if (typeof coachId !== 'string' || !coachId) throw new HttpsError('invalid-argument', 'coachId is required.');
  if (!['wrong_email', 'bounced'].includes(reason)) throw new HttpsError('invalid-argument', 'reason must be wrong_email or bounced.');
  const coachRef = db.doc(`coaches/${coachId}`);
  const reportRef = db.doc(`coachReports/${coachId}_${fid}`);
  return db.runTransaction(async (tx) => {
    const coach = await tx.get(coachRef);
    if (!coach.exists) throw new HttpsError('not-found', 'That coach was not found.');
    const reports = await tx.get(db.collection('coachReports').where('coachId', '==', coachId));
    const others = reports.docs.filter((d) => d.id !== reportRef.id);
    const bounced = reason === 'bounced' || others.some((d) => d.get('reason') === 'bounced');
    const count = others.length + 1;
    tx.set(reportRef, { coachId, fid, reason, at: FieldValue.serverTimestamp() });
    const suppressed = bounced || count >= 2;
    tx.update(coachRef, { reports: count, ...(suppressed ? { status: 'suppressed' } : {}) });
    return { reports: count, suppressed };
  });
});

// ---------- commitments ----------

/** Pure: committed-families average, published only from COMMITTED_MIN_REPORTS reports. */
function committedStats(gpas) {
  const list = gpas.filter((g) => typeof g === 'number' && Number.isFinite(g));
  if (list.length < COMMITTED_MIN_REPORTS) return null;
  return { count: list.length, avgGpa: Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100 };
}

/**
 * reportOutcome — record a commitment and, if the family agrees, share the GPA for school averages.
 * data: { playerId, targetId, share }
 */
const reportOutcome = onCall(async (req) => {
  const { fid } = await helpers.requireProFamily(req);
  const { playerId, targetId } = req.data || {};
  const share = Boolean(req.data?.share);
  if (typeof playerId !== 'string' || typeof targetId !== 'string') throw new HttpsError('invalid-argument', 'playerId and targetId are required.');
  const [player, target] = await Promise.all([
    db.doc(`families/${fid}/players/${playerId}`).get(),
    db.doc(`families/${fid}/players/${playerId}/targets/${targetId}`).get(),
  ]);
  if (!player.exists || !target.exists) throw new HttpsError('not-found', 'That school isn’t on the list.');
  const schoolId = target.get('schoolId');
  const sport = player.get('sport');
  const pa = player.get('academics') || {};
  const gpa = pa.gpa == null ? null : Math.round((pa.gpaScale === 5 ? (pa.gpa / 5) * 4 : Math.min(pa.gpa, 4)) * 100) / 100;
  await db.doc(`outcomes/${fid}_${playerId}`).set({
    schoolId: schoolId || null, sport, gpa, shareForStats: share && Boolean(schoolId) && gpa != null,
    committedAt: FieldValue.serverTimestamp(),
  });
  if (schoolId) {
    const all = await db.collection('outcomes').where('schoolId', '==', schoolId).where('sport', '==', sport).where('shareForStats', '==', true).get();
    await db.doc(`schoolStats/${schoolId}_${sport}`).set({ committed: committedStats(all.docs.map((d) => d.get('gpa'))), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return { ok: true };
});

// ---------- follow-up nudges ----------

/** Write a follow-up alert for every contact whose follow-up date has passed. */
async function runNudges(now = new Date()) {
  const due = await db.collectionGroup('contacts').where('nextFollowUpAt', '<=', Timestamp.fromDate(now)).get();
  let written = 0;
  for (const c of due.docs) {
    const d = c.data();
    const dueMs = d.nextFollowUpAt.toMillis();
    if (d.nudgedFor === dueMs) continue;
    const playerRef = c.ref.parent.parent;
    const alertRef = playerRef.collection('alerts').doc(`followup_${c.id}_${dueMs}`);
    const replied = d.stage === 'replied';
    await db.batch()
      .set(alertRef, {
        type: 'followup_due', severity: 'info', refs: { contactId: c.id },
        title: replied ? `Reply to ${d.name || 'the coach'} at ${d.schoolName || 'the school'}` : `Follow up with ${d.name || 'the coach'} at ${d.schoolName || 'the school'}`,
        dedupeKey: `followup:${c.id}:${dueMs}`, createdAt: FieldValue.serverTimestamp(), dismissedAt: null,
      }, { merge: true })
      .update(c.ref, { nudgedFor: dueMs })
      .commit();
    written += 1;
  }
  return written;
}

const dailyNudges = onSchedule({ schedule: 'every day 08:00', timeZone: 'America/New_York' }, async () => {
  await runNudges();
});

/** devRunNudges — EMULATOR ONLY: run the daily nudge job now (optionally as of a future date). */
const devRunNudges = onCall(async (req) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') throw new HttpsError('permission-denied', 'Not available.');
  helpers.requireAuth(req);
  const now = req.data?.asOf ? new Date(req.data.asOf) : new Date();
  return { written: await runNudges(now) };
});

module.exports = {
  init, contactCardLink, aiDraftEmail, onContactWrite, reportCoach, reportOutcome, dailyNudges, devRunNudges,
  // pure helpers for unit tests
  draftFacts, committedStats, suggestionId, SYSTEM_PROMPT, DRAFT_SCHEMA,
};
