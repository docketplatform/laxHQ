// Club schedule import (Phase 5): connect a calendar link, match it to a team, keep it synced,
// and keep each player's overlap alerts, planned-cost expenses and card "Summer" line current.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { normalizeFeedUrl, urlHash, parseFeed, eventDocId, uidOverlap, addDaysIso } = require('./lib/ics');
const { fetchFeed } = require('./lib/net');
const { findOverlaps, overlapAlerts } = require('./lib/overlap');

const db = getFirestore();
let helpers = null;
function init(h) { helpers = h; }

const MATCH_THRESHOLD = 0.8;
const FAILOVER_AFTER = 5;
const MAX_PENDING_EVENTS = 1500;
const today = () => new Date().toISOString().slice(0, 10);
const emulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

function friendly(e) {
  if (e instanceof HttpsError) return e;
  return new HttpsError('failed-precondition', e.message || 'Couldn’t read that calendar.');
}

// ---------- connect ----------

/**
 * connectSchedule — fetch a pasted calendar link and list the calendars in it.
 * data: { playerId, url } → { feedId, calendars: [{ name, count }], eventCount }
 */
const connectSchedule = onCall({ timeoutSeconds: 60 }, async (req) => {
  const { fid } = await helpers.requireProFamily(req);
  const { playerId } = req.data || {};
  const player = await db.doc(`families/${fid}/players/${playerId || '_'}`).get();
  if (!player.exists) throw new HttpsError('not-found', 'That player was not found.');
  let url; let parsed; let fetched;
  try {
    url = normalizeFeedUrl(req.data?.url, { allowHttp: emulator() });
    fetched = await fetchFeed(url);
    parsed = parseFeed(fetched.text);
  } catch (e) { throw friendly(e); }
  if (!parsed.events.length) throw new HttpsError('failed-precondition', 'That calendar has no upcoming events.');
  const hash = urlHash(url);
  const feedId = `${fid}_${hash.slice(0, 20)}`;
  await db.doc(`feeds/${feedId}`).set({
    url, urlHash: hash, fid, pid: playerId, calendarName: parsed.calendarName,
    calendarsFound: parsed.calendars, etag: fetched.etag || null, lastModified: fetched.lastModified || null,
    lastFetchAt: FieldValue.serverTimestamp(), consecutiveFailures: 0,
    pendingEvents: parsed.events.slice(0, MAX_PENDING_EVENTS),
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { feedId, calendars: parsed.calendars, calendarName: parsed.calendarName, eventCount: parsed.events.length };
});

async function writeTeamEvents(teamId, events, { cancelMissing = false } = {}) {
  const ref = db.collection(`teams/${teamId}/events`);
  const keep = new Set(events.map((e) => eventDocId(e.uid)));
  for (let i = 0; i < events.length; i += 400) {
    const batch = db.batch();
    for (const e of events.slice(i, i + 400)) batch.set(ref.doc(eventDocId(e.uid)), { ...e, updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }
  if (cancelMissing) {
    const future = await ref.where('startDate', '>=', today()).get();
    const gone = future.docs.filter((d) => !keep.has(d.id) && !d.get('cancelled'));
    for (let i = 0; i < gone.length; i += 400) {
      const batch = db.batch();
      gone.slice(i, i + 400).forEach((d) => batch.update(d.ref, { cancelled: true, updatedAt: FieldValue.serverTimestamp() }));
      await batch.commit();
    }
  }
}

const sampleOf = (events) => events.filter((e) => e.startDate >= today()).slice(0, 50).map((e) => e.uid);

/**
 * selectCalendars — keep the chosen calendars and join (or create) the team.
 * Matching: same link → that team; else 80%+ of a team's sample event UIDs → that team; else new.
 * data: { feedId, calendars: string[] } → { teamId, teamName, joined, eventCount }
 */
const selectCalendars = onCall({ timeoutSeconds: 120 }, async (req) => {
  const { fid } = await helpers.requireProFamily(req);
  const { feedId } = req.data || {};
  const chosen = Array.isArray(req.data?.calendars) ? req.data.calendars.map(String) : [];
  const feedRef = db.doc(`feeds/${feedId || '_'}`);
  const feed = await feedRef.get();
  if (!feed.exists || feed.get('fid') !== fid) throw new HttpsError('not-found', 'Connect the calendar link again.');
  const events = (feed.get('pendingEvents') || []).filter((e) => chosen.includes(e.calendar));
  if (!events.length) throw new HttpsError('invalid-argument', 'Pick at least one calendar with events.');
  const pid = feed.get('pid');
  const uids = events.map((e) => e.uid);

  // 1. Same link already joined to a team by another family.
  let teamId = null;
  const same = await db.collection('feeds').where('urlHash', '==', feed.get('urlHash')).get();
  for (const d of same.docs) if (d.id !== feedId && (d.get('teamIds') || []).length) { teamId = d.get('teamIds')[0]; break; }
  // 2. Different personal link for the same team: compare event UIDs.
  if (!teamId) {
    const probe = [...new Set(uids)].slice(0, 30);
    const cands = await db.collection('teams').where('uidSample', 'array-contains-any', probe).get();
    let best = null;
    for (const t of cands.docs) {
      const score = uidOverlap(t.get('uidSample'), uids);
      if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { id: t.id, score };
    }
    teamId = best?.id || null;
  }

  const joined = Boolean(teamId);
  let teamName;
  if (!teamId) {
    const teamRef = db.collection('teams').doc();
    teamId = teamRef.id;
    teamName = (chosen.length === 1 ? chosen[0] : feed.get('calendarName') || chosen.join(' + ')).slice(0, 100);
    await writeTeamEvents(teamId, events);
    await teamRef.set({
      name: teamName, sourceType: 'ics', memberFids: [fid], feedIds: [feedId], primaryFeedId: feedId,
      uidSample: sampleOf(events), eventCount: events.length, lastSyncAt: FieldValue.serverTimestamp(),
      syncStatus: 'ok', syncError: null, createdAt: FieldValue.serverTimestamp(),
    });
  } else {
    const teamRef = db.doc(`teams/${teamId}`);
    const team = await teamRef.get();
    teamName = team.get('name');
    const update = { memberFids: FieldValue.arrayUnion(fid), feedIds: FieldValue.arrayUnion(feedId) };
    if (team.get('syncStatus') === 'error') Object.assign(update, { primaryFeedId: feedId, syncStatus: 'ok', syncError: null });
    await teamRef.update(update);
    if (team.get('syncStatus') === 'error') await writeTeamEvents(teamId, events, { cancelMissing: true });
  }
  await feedRef.update({ selected: chosen, teamIds: FieldValue.arrayUnion(teamId), pendingEvents: FieldValue.delete() });
  await db.doc(`families/${fid}/players/${pid}`).update({ teamIds: FieldValue.arrayUnion(teamId) });
  await recomputeOverlaps(fid, pid);
  return { teamId, teamName, joined, eventCount: events.length };
});

/** disconnectTeam — stop syncing a team for one player. data: { playerId, teamId } */
const disconnectTeam = onCall(async (req) => {
  const { fid } = await helpers.requireProFamily(req);
  const { playerId, teamId } = req.data || {};
  const pref = db.doc(`families/${fid}/players/${playerId || '_'}`);
  const p = await pref.get();
  if (!p.exists || !(p.get('teamIds') || []).includes(teamId)) throw new HttpsError('not-found', 'That team isn’t connected.');
  await pref.update({ teamIds: FieldValue.arrayRemove(teamId) });
  const others = await db.collection(`families/${fid}/players`).where('teamIds', 'array-contains', teamId).get();
  if (others.empty) {
    const feeds = await db.collection('feeds').where('fid', '==', fid).where('teamIds', 'array-contains', teamId).get();
    await db.doc(`teams/${teamId}`).update({ memberFids: FieldValue.arrayRemove(fid), feedIds: FieldValue.arrayRemove(...feeds.docs.map((d) => d.id), '_') });
    await Promise.all(feeds.docs.map((d) => d.ref.delete()));
  }
  await recomputeOverlaps(fid, playerId);
  return { ok: true };
});

// ---------- sync ----------

async function teamPlayers(team) {
  const out = [];
  for (const fid of team.get('memberFids') || []) {
    const ps = await db.collection(`families/${fid}/players`).where('teamIds', 'array-contains', team.id).get();
    ps.docs.forEach((p) => out.push({ fid, pid: p.id }));
  }
  return out;
}

/** Sync one team from its primary feed, failing over to another member's feed after repeated errors. */
async function syncTeam(teamId) {
  const teamRef = db.doc(`teams/${teamId}`);
  let team = await teamRef.get();
  if (!team.exists) return { teamId, status: 'missing' };
  const tried = new Set();
  for (;;) {
    const feedId = team.get('primaryFeedId');
    tried.add(feedId);
    const feedRef = db.doc(`feeds/${feedId}`);
    const feed = await feedRef.get();
    try {
      if (!feed.exists) throw new Error('The calendar link was removed.');
      const res = await fetchFeed(feed.get('url'), { etag: feed.get('etag'), lastModified: feed.get('lastModified') });
      if (res.status === 200) {
        const selected = feed.get('selected') || [];
        const events = parseFeed(res.text).events.filter((e) => !selected.length || selected.includes(e.calendar));
        await writeTeamEvents(teamId, events, { cancelMissing: true });
        await feedRef.update({ etag: res.etag || null, lastModified: res.lastModified || null, lastFetchAt: FieldValue.serverTimestamp(), consecutiveFailures: 0 });
        await teamRef.update({ uidSample: sampleOf(events), eventCount: events.length, lastSyncAt: FieldValue.serverTimestamp(), syncStatus: 'ok', syncError: null });
      } else {
        await feedRef.update({ lastFetchAt: FieldValue.serverTimestamp(), consecutiveFailures: 0 });
        await teamRef.update({ lastSyncAt: FieldValue.serverTimestamp(), syncStatus: 'ok', syncError: null });
      }
      for (const { fid, pid } of await teamPlayers(team)) await recomputeOverlaps(fid, pid);
      return { teamId, status: res.status === 304 ? 'unchanged' : 'synced' };
    } catch (e) {
      const failures = (feed.exists ? feed.get('consecutiveFailures') || 0 : FAILOVER_AFTER) + 1;
      if (feed.exists) await feedRef.update({ consecutiveFailures: failures, lastError: e.message });
      if (failures < FAILOVER_AFTER) {
        await teamRef.update({ syncError: e.message });
        return { teamId, status: 'retry-later', error: e.message };
      }
      const next = (team.get('feedIds') || []).find((f) => !tried.has(f));
      if (next) {
        await teamRef.update({ primaryFeedId: next });
        team = await teamRef.get();
        continue;
      }
      await teamRef.update({ syncStatus: 'error', syncError: e.message });
      for (const { fid, pid } of await teamPlayers(team)) {
        await db.doc(`families/${fid}/players/${pid}/alerts/sync_${teamId}`).set({
          type: 'sync_failed', severity: 'warn', refs: { teamId },
          title: `${team.get('name')} stopped syncing. Paste a fresh calendar link on the Events tab.`,
          dedupeKey: `sync:${teamId}`, createdAt: FieldValue.serverTimestamp(), dismissedAt: null,
        });
      }
      return { teamId, status: 'error', error: e.message };
    }
  }
}

const syncTeams = onSchedule({ schedule: 'every 6 hours', timeoutSeconds: 540 }, async () => {
  const teams = await db.collection('teams').get();
  for (const t of teams.docs) {
    if ((t.get('memberFids') || []).length) await syncTeam(t.id).catch((e) => console.error('sync', t.id, e));
  }
});

/** devSyncTeams — EMULATOR ONLY: sync the caller's teams now. */
const devSyncTeams = onCall({ timeoutSeconds: 120 }, async (req) => {
  if (!emulator()) throw new HttpsError('permission-denied', 'Not available.');
  helpers.requireAuth(req);
  const fid = req.auth.token.fid;
  const teams = await db.collection('teams').where('memberFids', 'array-contains', fid).get();
  const results = [];
  for (const t of teams.docs) results.push(await syncTeam(t.id));
  return { results };
});

// ---------- overlaps, planned expenses, card summer ----------

/** Recompute one player's overlap alerts from their plan and their teams' events. */
async function recomputeOverlaps(fid, pid) {
  const pref = db.doc(`families/${fid}/players/${pid}`);
  const player = await pref.get();
  if (!player.exists) return [];
  const plan = (await pref.collection('plan').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const teamEvents = [];
  for (const teamId of player.get('teamIds') || []) {
    const team = await db.doc(`teams/${teamId}`).get();
    const evs = await db.collection(`teams/${teamId}/events`).where('endDate', '>=', addDaysIso(today(), -1)).get();
    evs.docs.forEach((d) => teamEvents.push({ id: d.id, teamId, teamName: team.get('name'), ...d.data() }));
  }
  const alerts = overlapAlerts(findOverlaps(plan, teamEvents));
  const existing = await pref.collection('alerts').where('type', '==', 'overlap').get();
  const batch = db.batch();
  const keep = new Set(alerts.map((a) => a.id));
  for (const a of alerts) {
    const prev = existing.docs.find((d) => d.id === a.id);
    const same = prev && prev.get('dedupeKey') === a.key;
    batch.set(pref.collection('alerts').doc(a.id), {
      type: 'overlap', severity: 'warn', title: a.title, refs: a.refs, dedupeKey: a.key,
      createdAt: same ? prev.get('createdAt') : FieldValue.serverTimestamp(), dismissedAt: same ? prev.get('dismissedAt') : null,
    });
  }
  existing.docs.filter((d) => !keep.has(d.id)).forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return alerts;
}

const KIND_CATEGORY = { showcase: 'tournaments', tournament: 'tournaments', camp: 'camps', prospect_day: 'camps', other: 'other' };
const seasonOf = (iso) => { const [y, m] = iso.split('-').map(Number); const s = m >= 9 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

/** Planned-cost expense for a summer event (or null to remove it). Pure. */
function planExpense(pid, ev) {
  if (!ev || ev.status === 'skipped' || !ev.start) return null;
  const attended = ev.status === 'attended';
  const dollars = attended && ev.actualCost != null ? ev.actualCost : ev.costEstimate;
  const cents = Math.round(Number(dollars) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return {
    amountCents: cents, date: ev.start, season: seasonOf(ev.start), category: KIND_CATEGORY[ev.kind] || 'tournaments',
    payee: String(ev.title || 'Event').slice(0, 100), note: ev.location?.city ? `${ev.location.city}${ev.location.state ? `, ${ev.location.state}` : ''}` : null,
    playerIds: [pid], status: attended ? 'spent' : 'planned', source: 'plan',
  };
}

/** Card "Summer" line: cities of events the player is registered for or attending. Pure. */
function cardSummer(plan) {
  return plan.filter((e) => ['registered', 'attended'].includes(e.status) && e.start >= `${new Date().getFullYear() - 1}-01-01`)
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => e.location?.city || e.title).filter(Boolean).slice(0, 6);
}

/** Card "Where to see me": registered/attended events from last year on (the card shows upcoming ones). Pure. */
function cardEvents(plan) {
  return plan.filter((e) => ['registered', 'attended'].includes(e.status) && e.start >= `${new Date().getFullYear() - 1}-01-01`)
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => ({
      title: String(e.title || 'Event').slice(0, 120), start: e.start, end: e.end || null,
      city: e.location?.city || null, state: e.location?.state || null,
    })).slice(0, 12);
}

const onPlanWrite = onDocumentWritten('families/{fid}/players/{pid}/plan/{eid}', async (event) => {
  const { fid, pid, eid } = event.params;
  const after = event.data.after.exists ? event.data.after.data() : null;
  const expRef = db.doc(`families/${fid}/expenses/plan_${pid}_${eid}`);
  const exp = planExpense(pid, after);
  if (exp) await expRef.set({ ...exp, planEventId: eid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  else await expRef.delete();

  const pref = db.doc(`families/${fid}/players/${pid}`);
  const plan = (await pref.collection('plan').get()).docs.map((d) => d.data());
  const summer = cardSummer(plan);
  const events = cardEvents(plan);
  const player = await pref.get();
  if (player.exists && (JSON.stringify(player.get('cardSummer') || []) !== JSON.stringify(summer)
    || JSON.stringify(player.get('cardEvents') || []) !== JSON.stringify(events))) await pref.update({ cardSummer: summer, cardEvents: events });
  await recomputeOverlaps(fid, pid);
});

module.exports = {
  init, connectSchedule, selectCalendars, disconnectTeam, syncTeams, devSyncTeams, onPlanWrite,
  syncTeam, recomputeOverlaps, planExpense, cardSummer, cardEvents,
};
