// Recruiting card: the public projection of a player, and view tracking.
//
// cards/{slug}      public, read by anyone with the link. Built only from fields that are
//                   meant to be shared; private fields never reach it.
// cardSlugs/{slug}  server-only map slug → { fid, pid }.
// cardTokens/{tok}  server-only map per-coach link token → { fid, pid, contactId, schoolName }.
// cardViews/{slug}/views/{id}  server-only view log.

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('node:crypto');

const db = getFirestore();

const STAT_KEYS = ['goals', 'assists', 'groundBalls', 'causedTO', 'saves', 'savePct', 'faceoffPct', 'drawControls'];

/**
 * The name on the card. Full name unless the family chose first name + last initial
 * (player.cardNameStyle === 'initial'); then the last name never reaches the card.
 */
function cardName(player) {
  const first = player.firstName || '';
  const last = player.lastName || '';
  const initial = last.slice(0, 1).toUpperCase();
  const full = player.cardNameStyle !== 'initial';
  return {
    firstName: first,
    lastInitial: initial,
    lastName: full ? last : null,
    name: full ? `${first} ${last}`.trim() : `${first} ${initial}${initial ? '.' : ''}`.trim(),
  };
}

/** Videos on the card: the main reel (filmUrl) first, then the extra videos. */
function cardVideos(player) {
  const list = [];
  if (player.filmUrl) list.push({ title: player.filmTitle || 'Highlight reel', url: player.filmUrl, kind: 'highlight', date: player.filmDate || null });
  for (const v of player.videos || []) if (v?.url && v.url !== player.filmUrl) list.push({ title: v.title || null, url: v.url, kind: v.kind || 'other', date: v.date || null });
  return list.slice(0, 9);
}

/** The public card for a player. Only shareable fields. */
function buildCard(player, { contactEmail, summer = [] } = {}) {
  const stats = {};
  for (const k of STAT_KEYS) if (player.stats && player.stats[k] != null) stats[k] = player.stats[k];
  return {
    ...cardName(player),
    sport: player.sport || null,
    position: player.position || null,
    otherPositions: player.otherPositions || [],
    heightIn: player.heightIn ?? null,
    hand: player.hand || null,
    hometown: player.hometown?.city ? { city: player.hometown.city, state: player.hometown.state || null } : null,
    statement: player.statement || null,
    honors: player.honors || [],
    social: player.social?.x || player.social?.instagram ? { x: player.social.x || null, instagram: player.social.instagram || null } : null,
    badges: [player.athletic?.varsityStarter ? 'Varsity starter' : null, player.athletic?.allConference ? 'All-conference / all-state' : null].filter(Boolean),
    tests: player.academics?.showTests && (player.academics.sat || player.academics.act) ? { sat: player.academics.sat || null, act: player.academics.act || null } : null,
    gpaWeighted: player.academics?.gpa != null ? Boolean(player.academics.weighted) : null,
    gradYear: player.gradYear || null,
    jersey: player.jersey || null,
    highSchool: player.highSchool?.name ? { name: player.highSchool.name, state: player.highSchool.state || null, jersey: player.highSchool.jersey || null } : null,
    club: player.club?.name ? { name: player.club.name, team: player.club.team || null, level: player.club.level || null, jersey: player.club.jersey || null } : null,
    gpa: player.academics?.gpa ?? null,
    gpaScale: player.academics?.gpaScale ?? 4,
    stats,
    statsSeason: player.stats?.season || null,
    rankings: (player.rankings || []).map((r) => ({ source: r.source, value: r.value, url: r.url || null })),
    filmUrl: player.filmUrl || null,
    videos: cardVideos(player),
    events: (player.cardEvents || []).slice(0, 8),
    summer,
    contactEmail: contactEmail || null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** Pure: update cardStats with one video play. */
function applyVideoPlay(stats = {}, { now, schoolName, title }) {
  const daily = { ...(stats.videoDaily || {}) };
  const today = dayKey(now);
  daily[today] = (daily[today] || 0) + 1;
  const cutoff = dayKey(new Date(now.getTime() - (DAYS_KEPT - 1) * 864e5));
  for (const k of Object.keys(daily)) if (k < cutoff) delete daily[k];
  const recentVideoViews = [{ schoolName: schoolName || null, title: title || 'Video', at: now }, ...(stats.recentVideoViews || [])].slice(0, 8);
  return {
    ...stats,
    videoDaily: daily,
    videoPlays30d: Object.values(daily).reduce((a, b) => a + b, 0),
    videoPlays: (stats.videoPlays || 0) + 1,
    recentVideoViews,
  };
}

/** Email shown on the card: the family owner's (the parent who set up the account). */
async function familyContactEmail(fid) {
  const fam = await db.doc(`families/${fid}`).get();
  const owner = fam.get('ownerUid');
  if (!owner) return null;
  const user = await db.doc(`users/${owner}`).get();
  return user.get('email') || null;
}

/** Keep cards/{slug} and cardSlugs/{slug} in step with the player doc. */
const onPlayerWrite = onDocumentWritten('families/{fid}/players/{pid}', async (event) => {
  const { fid, pid } = event.params;
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  const slug = (after || before)?.cardSlug;
  if (!slug) return;

  if (!after) {
    await Promise.all([db.doc(`cards/${slug}`).delete(), db.doc(`cardSlugs/${slug}`).delete()]);
    return;
  }
  if (!before || before.cardSlug !== after.cardSlug) {
    await db.doc(`cardSlugs/${slug}`).set({ fid, pid });
  }
  if (!after.cardPublished) {
    if (before?.cardPublished) await db.doc(`cards/${slug}`).delete();
    return;
  }
  // Rebuild only when a shared field changed (cardStats updates from views don't count).
  const shared = (p) => JSON.stringify(p && { ...buildCard(p), updatedAt: null, published: p.cardPublished, summer: p.cardSummer || [] });
  if (before && before.cardPublished && shared(before) === shared(after)) return;
  const contactEmail = await familyContactEmail(fid);
  await db.doc(`cards/${slug}`).set(buildCard(after, { contactEmail, summer: after.cardSummer || [] }));
});

// ---------- view tracking ----------

// Link scanners and bots that open links in emails. The card page also only reports a view
// from JavaScript, which most scanners never run.
const BOT_UA = /bot|crawl|spider|slurp|preview|scanner|safelinks|proofpoint|mimecast|barracuda|facebookexternalhit|whatsapp|slack|discord|telegram|skype|curl|wget|python|java\/|go-http|headless|phantom|lighthouse/i;
const DEDUPE_MINUTES = 30;
const DAYS_KEPT = 30;

function dayKey(d) { return d.toISOString().slice(0, 10); }

/** Pure: update cardStats with one view. */
function applyView(stats = {}, { now, schoolName }) {
  const daily = { ...(stats.daily || {}) };
  const today = dayKey(now);
  daily[today] = (daily[today] || 0) + 1;
  const cutoff = dayKey(new Date(now.getTime() - (DAYS_KEPT - 1) * 864e5));
  for (const k of Object.keys(daily)) if (k < cutoff) delete daily[k];
  const views30d = Object.values(daily).reduce((a, b) => a + b, 0);
  let recentSchools = stats.recentSchools || [];
  if (schoolName) recentSchools = [schoolName, ...recentSchools.filter((s) => s !== schoolName)].slice(0, 5);
  return {
    daily, views30d, total: (stats.total || 0) + 1, lastViewAt: now,
    recentSchools, tokenViews: (stats.tokenViews || 0) + (schoolName ? 1 : 0),
  };
}

/**
 * POST /cardView { slug, r? } — log one view of a published card.
 * r = the per-coach token from a tracked link. Bots and repeat views within 30 minutes don't count.
 */
const cardView = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const slug = String(body.slug || '').replace(/[^a-z0-9]/g, '').slice(0, 16);
  const token = String(body.r || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || null;
  const ua = String(req.get('user-agent') || '');
  if (!slug) { res.status(400).json({ error: 'slug required' }); return; }
  if (BOT_UA.test(ua) && !process.env.LAXHQ_ALLOW_HEADLESS) { res.json({ counted: false, reason: 'bot' }); return; }

  const map = await db.doc(`cardSlugs/${slug}`).get();
  const card = await db.doc(`cards/${slug}`).get();
  if (!map.exists || !card.exists) { res.status(404).json({ error: 'not found' }); return; }
  const { fid, pid } = map.data();

  let tokenInfo = null;
  if (token) {
    const t = await db.doc(`cardTokens/${token}`).get();
    if (t.exists && t.get('fid') === fid && t.get('pid') === pid) tokenInfo = t.data();
  }

  const ip = String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
  const viewer = crypto.createHash('sha256').update(`${slug}|${ip}|${ua}|${token || ''}`).digest('hex').slice(0, 32);
  const now = new Date();
  const dedupeRef = db.doc(`cardViews/${slug}/recent/${viewer}`);
  const playerRef = db.doc(`families/${fid}/players/${pid}`);

  if (body.event === 'video') {
    const idx = Math.max(0, Math.min(8, Number.parseInt(body.v, 10) || 0));
    const video = (card.get('videos') || [])[idx];
    if (!video) { res.status(404).json({ error: 'no such video' }); return; }
    const title = video.title || (video.kind === 'game' ? 'game film' : 'highlight reel');
    const playRef = db.doc(`cardViews/${slug}/recent/${viewer}_v${idx}`);
    const counted = await db.runTransaction(async (tx) => {
      const [recent, player] = await Promise.all([tx.get(playRef), tx.get(playerRef)]);
      if (recent.exists && now - recent.get('at').toDate() < DEDUPE_MINUTES * 60e3) return false;
      tx.set(playRef, { at: now });
      tx.set(db.collection(`cardViews/${slug}/views`).doc(), {
        at: now, type: 'video', video: idx, videoTitle: title,
        token: tokenInfo ? token : null, contactId: tokenInfo?.contactId || null, schoolName: tokenInfo?.schoolName || null,
      });
      tx.update(playerRef, { cardStats: applyVideoPlay(player.get('cardStats'), { now, schoolName: tokenInfo?.schoolName || null, title }) });
      // Public play count per video (shown on the card), keyed by the video's link.
      tx.set(db.doc(`cardCounts/${slug}`), { videos: { [video.url]: FieldValue.increment(1) } }, { merge: true });
      if (tokenInfo?.contactId) {
        tx.set(db.doc(`families/${fid}/players/${pid}/contacts/${tokenInfo.contactId}`), { lastVideoViewAt: now, videoViews: FieldValue.increment(1) }, { merge: true });
      }
      if (tokenInfo?.schoolName) {
        // One alert per coach and video, so the family knows film was actually watched.
        tx.set(db.doc(`families/${fid}/players/${pid}/alerts/video_${token}_${idx}`), {
          type: 'video_watched', severity: 'info',
          title: `A coach at ${tokenInfo.schoolName} watched ${player.get('firstName') || 'your player'}’s ${title}`,
          refs: { contactId: tokenInfo.contactId || null }, createdAt: now, dismissedAt: null,
        });
      }
      return true;
    });
    res.json({ counted });
    return;
  }

  const counted = await db.runTransaction(async (tx) => {
    const [recent, player] = await Promise.all([tx.get(dedupeRef), tx.get(playerRef)]);
    if (recent.exists && now - recent.get('at').toDate() < DEDUPE_MINUTES * 60e3) return false;
    tx.set(dedupeRef, { at: now });
    tx.set(db.collection(`cardViews/${slug}/views`).doc(), {
      at: now, token: tokenInfo ? token : null, contactId: tokenInfo?.contactId || null, schoolName: tokenInfo?.schoolName || null,
    });
    tx.update(playerRef, { cardStats: applyView(player.get('cardStats'), { now, schoolName: tokenInfo?.schoolName || null }) });
    if (tokenInfo?.contactId) {
      tx.set(db.doc(`families/${fid}/players/${pid}/contacts/${tokenInfo.contactId}`), { lastCardViewAt: now, cardViews: FieldValue.increment(1) }, { merge: true });
    }
    return true;
  });
  res.json({ counted });
});

module.exports = {
  cardName, cardVideos, applyVideoPlay, familyContactEmail, onPlayerWrite, cardView, buildCard, applyView, BOT_UA };
