// Validation for player profiles written by addPlayer (and reused by updatePlayer).
// Returns a clean object or throws { field, message }.

const SPORTS = ['mlax', 'wlax'];
const POSITIONS = ['attack', 'midfield', 'defense', 'lsm', 'fogo', 'goalie', 'draw'];
const DIVISIONS = ['D1', 'D2', 'D3'];
const CLUB_LEVELS = ['national', 'regional', 'local'];
const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const STAT_KEYS = ['goals', 'assists', 'groundBalls', 'causedTO', 'saves', 'savePct', 'faceoffPct', 'drawControls'];

class ValidationError extends Error {
  constructor(field, message) { super(message); this.field = field; }
}

function str(v, field, { max = 80, required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ValidationError(field, `${field} is required.`);
    return null;
  }
  if (typeof v !== 'string') throw new ValidationError(field, `${field} must be text.`);
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s && required) throw new ValidationError(field, `${field} is required.`);
  if (s.length > max) throw new ValidationError(field, `${field} is too long.`);
  return s || null;
}

/** Multi-line text: keeps line breaks, trims each line, caps blank lines. */
function longText(v, field, { max = 1500 } = {}) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ValidationError(field, `${field} must be text.`);
  const s = v.replace(/\r/g, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > max) throw new ValidationError(field, `${field} is too long (${max} characters at most).`);
  return s || null;
}

/** A social handle from "@name", "name" or a profile link. */
function handle(v, field) {
  const s = str(v, field, { max: 120 });
  if (!s) return null;
  const h = s.replace(/^https?:\/\/(www\.)?(x|twitter|instagram)\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(h)) throw new ValidationError(field, `${field} should look like @name.`);
  return h;
}

function num(v, field, { min, max, integer = false } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ValidationError(field, `${field} must be a number.`);
  if (integer && !Number.isInteger(n)) throw new ValidationError(field, `${field} must be a whole number.`);
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new ValidationError(field, `${field} must be between ${min} and ${max}.`);
  }
  return n;
}

function oneOf(v, list, field, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ValidationError(field, `${field} is required.`);
    return null;
  }
  if (!list.includes(v)) throw new ValidationError(field, `${field} is not valid.`);
  return v;
}

const VIDEO_KINDS = ['highlight', 'game', 'skills', 'other'];

function url(v, field) {
  const s = str(v, field, { max: 500 });
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { throw new ValidationError(field, `${field} must be a link starting with https://`); }
  if (!['https:', 'http:'].includes(u.protocol)) throw new ValidationError(field, `${field} must be a web link.`);
  return u.toString();
}

/** School year that ends in June of the returned year; flips on Aug 1. */
function schoolYearEnding(now = new Date()) {
  return now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
}

/**
 * Validate and normalize a player profile.
 * @param {object} input raw data from the client
 * @param {{ now?: Date, partial?: boolean }} opts partial = only validate the fields present
 */
function validatePlayer(input, { now = new Date(), partial = false } = {}) {
  if (!input || typeof input !== 'object') throw new ValidationError('player', 'Player details are missing.');
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const need = (k) => !partial || has(k);

  if (need('firstName')) out.firstName = str(input.firstName, 'First name', { max: 40, required: true });
  if (need('lastName')) out.lastName = str(input.lastName, 'Last name', { max: 40, required: true });
  if (need('sport')) out.sport = oneOf(input.sport, SPORTS, 'Sport', { required: true });
  if (need('gradYear')) {
    const first = schoolYearEnding(now);
    out.gradYear = num(input.gradYear, 'Grad year', { min: first, max: first + 6, integer: true });
    if (out.gradYear === null) throw new ValidationError('Grad year', 'Grad year is required.');
  }
  if (need('position')) out.position = oneOf(input.position, POSITIONS, 'Position', { required: true });
  if (has('jersey')) out.jersey = str(input.jersey, 'Jersey', { max: 3 });
  if (has('otherPositions')) {
    const list = Array.isArray(input.otherPositions) ? input.otherPositions : [];
    out.otherPositions = [...new Set(list)].filter((x) => POSITIONS.includes(x) && x !== (out.position || input.position)).slice(0, 3);
  }
  if (has('heightIn')) out.heightIn = num(input.heightIn, 'Height', { min: 48, max: 90, integer: true });
  if (has('hand')) out.hand = oneOf(input.hand, ['R', 'L', 'B'], 'Dominant hand');
  if (has('hometown')) {
    const h = input.hometown || {};
    out.hometown = { city: str(h.city, 'Hometown', { max: 60 }), state: oneOf(h.state, STATES, 'Hometown state') };
  }
  if (has('statement')) out.statement = longText(input.statement, 'Personal statement', { max: 1500 });
  if (has('honors')) {
    out.honors = (Array.isArray(input.honors) ? input.honors : []).slice(0, 12)
      .map((h, i) => str(h, `Honor ${i + 1}`, { max: 140 })).filter(Boolean);
  }
  if (has('social')) {
    const so = input.social || {};
    out.social = { x: handle(so.x, 'X handle'), instagram: handle(so.instagram, 'Instagram handle') };
  }
  if (need('openDivisions')) {
    const list = Array.isArray(input.openDivisions) ? input.openDivisions : [];
    const clean = [...new Set(list)].filter((d) => DIVISIONS.includes(d));
    if (!clean.length) throw new ValidationError('Divisions', 'Pick at least one division.');
    out.openDivisions = DIVISIONS.filter((d) => clean.includes(d));
  }
  if (has('highSchool')) {
    const hs = input.highSchool || {};
    out.highSchool = {
      name: str(hs.name, 'High school', { max: 100 }),
      state: oneOf(hs.state, STATES, 'High school state'),
      ncesId: str(hs.ncesId, 'NCES id', { max: 20 }),
      jersey: str(hs.jersey, 'High school jersey', { max: 3 }),
    };
  }
  if (has('academics')) {
    const a = input.academics || {};
    const scale = num(a.gpaScale, 'GPA scale', { min: 4, max: 5 }) ?? 4;
    out.academics = {
      gpa: num(a.gpa, 'GPA', { min: 0, max: scale }),
      gpaScale: scale,
      weighted: Boolean(a.weighted),
      sat: num(a.sat, 'SAT', { min: 400, max: 1600, integer: true }),
      act: num(a.act, 'ACT', { min: 1, max: 36, integer: true }),
      transcriptUploaded: Boolean(a.transcriptUploaded),
      showTests: Boolean(a.showTests),
    };
  }
  if (has('club')) {
    const c = input.club || {};
    out.club = {
      clubId: str(c.clubId, 'Club id', { max: 60 }),
      name: str(c.name, 'Club', { max: 80 }),
      team: str(c.team, 'Club team', { max: 40 }),
      level: oneOf(c.level, CLUB_LEVELS, 'Club level'),
      jersey: str(c.jersey, 'Club jersey', { max: 3 }),
    };
  }
  if (has('rankings')) {
    const list = Array.isArray(input.rankings) ? input.rankings.slice(0, 10) : [];
    out.rankings = list.map((r, i) => ({
      source: str(r && r.source, `Ranking ${i + 1} source`, { max: 60, required: true }),
      value: str(r && r.value, `Ranking ${i + 1}`, { max: 60, required: true }),
      url: url(r && r.url, `Ranking ${i + 1} link`),
      selfReported: true,
    }));
  }
  if (has('stats')) {
    const s = input.stats || {};
    out.stats = { season: str(s.season, 'Stats season', { max: 30 }) };
    for (const k of STAT_KEYS) out.stats[k] = num(s[k], k, { min: 0, max: k.endsWith('Pct') ? 100 : 1000 });
  }
  if (has('athletic')) {
    const a = input.athletic || {};
    out.athletic = { varsityStarter: Boolean(a.varsityStarter), allConference: Boolean(a.allConference) };
  }
  if (has('filmUrl')) out.filmUrl = url(input.filmUrl, 'Film link');
  if (has('filmTitle')) out.filmTitle = str(input.filmTitle, 'Reel title', { max: 80 });
  if (has('filmDate')) out.filmDate = /^\d{4}-(0[1-9]|1[0-2])$/.test(input.filmDate || '') ? input.filmDate : null;
  if (has('videos')) {
    out.videos = (Array.isArray(input.videos) ? input.videos : []).filter((v) => v && (v.url || v.title)).slice(0, 8)
      .map((v, i) => ({
        title: str(v.title, `Video ${i + 1} title`, { max: 80 }) || null,
        url: url(v.url, `Video ${i + 1} link`),
        kind: VIDEO_KINDS.includes(v.kind) ? v.kind : 'other',
        date: /^\d{4}-(0[1-9]|1[0-2])$/.test(v.date || '') ? v.date : null,
      }))
      .map((v, i) => { if (!v.url) throw new ValidationError(`videos.${i}.url`, `Add a link for video ${i + 1}.`); return v; });
  }
  if (has('regions')) {
    out.regions = (Array.isArray(input.regions) ? input.regions : []).slice(0, 8)
      .map((r, i) => str(r, `Region ${i + 1}`, { max: 40 })).filter(Boolean);
  }
  return out;
}

module.exports = {
  VIDEO_KINDS,
  validatePlayer, ValidationError, SPORTS, POSITIONS, DIVISIONS, CLUB_LEVELS, STATES, STAT_KEYS, schoolYearEnding,
};
