// Player profile form, used by onboarding (first player and siblings) and the profile screen.
import { esc, options } from '../util.js';
import { SPORTS, POSITIONS, DIVISIONS, CLUB_LEVELS, STATES, STATS_BY_POSITION, STAT_LABELS } from '../lib/options.js';
import { gradYearOptions } from '../lib/plan.js';
import { VIDEO_KINDS } from '../lib/video.js';

/**
 * @param {object} p        existing player (or draft) values
 * @param {object} opts     { id, full: include rankings/stats/film, submitLabel }
 */
export function playerFormHtml(p = {}, { id = 'player-form', full = false, submitLabel = 'Save' } = {}) {
  const sport = p.sport || 'mlax';
  const hs = p.highSchool || {}; const ac = p.academics || {}; const club = p.club || {};
  const years = gradYearOptions();
  const statKeys = STATS_BY_POSITION[p.position] || ['goals', 'assists', 'groundBalls'];
  const rankings = [...(p.rankings || []), {}].slice(0, 3);
  const videoRows = [...(p.videos || []), {}].slice(0, 8);

  return `<form id="${id}" class="stack" data-keep novalidate>
    <fieldset class="card"><legend><h2>Player</h2></legend>
      <div class="two">
        <div class="field"><label for="${id}-first">First name</label><input id="${id}-first" name="firstName" value="${esc(p.firstName)}" autocomplete="off" required maxlength="40"></div>
        <div class="field"><label for="${id}-last">Last name</label><input id="${id}-last" name="lastName" value="${esc(p.lastName)}" autocomplete="off" required maxlength="40"></div>
      </div>
      <div class="field"><label for="${id}-sport">Sport</label><select id="${id}-sport" name="sport">${options(SPORTS, sport)}</select></div>
      <div class="two">
        <div class="field"><label for="${id}-grad">Grad year</label><select id="${id}-grad" name="gradYear" data-type="number">${options(years.map((y) => ({ value: y, label: `Class of ${y}` })), p.gradYear, { blank: 'Choose' })}</select></div>
        <div class="field"><label for="${id}-pos">Position</label><select id="${id}-pos" name="position">${options(POSITIONS[sport], p.position, { blank: 'Choose' })}</select></div>
      </div>
      <fieldset class="field"><legend class="label">Divisions you’re open to</legend>
        <div class="checks">${DIVISIONS.map((d) => `<label class="check"><input type="checkbox" name="openDivisions[]" value="${d}"${(p.openDivisions || DIVISIONS).includes(d) ? ' checked' : ''}> ${d}</label>`).join('')}</div>
      </fieldset>
      ${full ? `<div class="field"><label for="${id}-jersey">Jersey number</label><input id="${id}-jersey" name="jersey" value="${esc(p.jersey)}" maxlength="3" inputmode="numeric"></div>` : ''}
    </fieldset>

    <fieldset class="card"><legend><h2>School and grades</h2></legend>
      <div class="two">
        <div class="field"><label for="${id}-hs">High school</label><input id="${id}-hs" name="highSchool.name" value="${esc(hs.name)}" maxlength="100"></div>
        <div class="field"><label for="${id}-hss">State</label><select id="${id}-hss" name="highSchool.state">${options(STATES, hs.state, { blank: 'Choose' })}</select></div>
      </div>
      <div class="two">
        <div class="field"><label for="${id}-gpa">GPA</label><input id="${id}-gpa" name="academics.gpa" data-type="number" inputmode="decimal" value="${esc(ac.gpa)}" placeholder="3.7"></div>
        <div class="field"><label for="${id}-scale">GPA scale</label><select id="${id}-scale" name="academics.gpaScale" data-type="number">${options([{ value: 4, label: 'Out of 4.0' }, { value: 5, label: 'Out of 5.0' }], ac.gpaScale || 4)}</select></div>
      </div>
      <label class="check"><input type="checkbox" name="academics.weighted"${ac.weighted ? ' checked' : ''}> Weighted GPA</label>
      ${full ? `<div class="two">
        <div class="field"><label for="${id}-sat">SAT (optional)</label><input id="${id}-sat" name="academics.sat" data-type="number" inputmode="numeric" value="${esc(ac.sat)}"></div>
        <div class="field"><label for="${id}-act">ACT (optional)</label><input id="${id}-act" name="academics.act" data-type="number" inputmode="numeric" value="${esc(ac.act)}"></div>
      </div>` : ''}
    </fieldset>

    <fieldset class="card"><legend><h2>Club team</h2></legend>
      <div class="field"><label for="${id}-club">Club</label><input id="${id}-club" name="club.name" value="${esc(club.name)}" maxlength="80" placeholder="e.g. Chesapeake Elite"></div>
      <div class="two">
        <div class="field"><label for="${id}-team">Team</label><input id="${id}-team" name="club.team" value="${esc(club.team)}" maxlength="40" placeholder="2029"></div>
        <div class="field"><label for="${id}-level">Level</label><select id="${id}-level" name="club.level">${options(CLUB_LEVELS, club.level, { blank: 'Choose' })}</select></div>
      </div>
      <div class="checks">
        <label class="check"><input type="checkbox" name="athletic.varsityStarter"${p.athletic?.varsityStarter ? ' checked' : ''}> Varsity starter</label>
        <label class="check"><input type="checkbox" name="athletic.allConference"${p.athletic?.allConference ? ' checked' : ''}> All-conference or all-state</label>
      </div>
      <p class="small">Used for the athletic fit estimate on your school list.</p>
    </fieldset>

    ${full ? `<fieldset class="card"><legend><h2>Rankings</h2></legend>
      <p class="small">Self-reported. Paste a link to the profile so coaches can check it.</p>
      ${rankings.map((r, i) => `<div class="three">
        <div class="field"><label for="${id}-rs${i}">Source</label><input id="${id}-rs${i}" name="rankings.${i}.source" value="${esc(r.source)}" placeholder="Inside Lacrosse"></div>
        <div class="field"><label for="${id}-rv${i}">Ranking</label><input id="${id}-rv${i}" name="rankings.${i}.value" value="${esc(r.value)}" placeholder="3 stars"></div>
        <div class="field"><label for="${id}-ru${i}">Link</label><input id="${id}-ru${i}" name="rankings.${i}.url" value="${esc(r.url)}" type="url" placeholder="https://"></div>
      </div>`).join('')}
    </fieldset>

    <fieldset class="card"><legend><h2>Stats and film</h2></legend>
      <div class="field"><label for="${id}-season">Season</label><input id="${id}-season" name="stats.season" value="${esc(p.stats?.season)}" placeholder="2026 high school"></div>
      <div class="two">${statKeys.map((k) => `<div class="field"><label for="${id}-st-${k}">${STAT_LABELS[k]}</label><input id="${id}-st-${k}" name="stats.${k}" data-type="number" inputmode="decimal" value="${esc(p.stats?.[k])}"></div>`).join('')}</div>
    </fieldset>

    <fieldset class="card" id="${id}-videos"><legend><h2>Videos</h2></legend>
      <p class="small">They play right on the recruiting card. Paste links from Hudl, YouTube, Vimeo or Google Drive (set it to “Anyone with the link”). For Hudl, use the video’s full address (hudl.com/video/…).</p>
      <div class="field"><label for="${id}-film">Main highlight reel</label><input id="${id}-film" name="filmUrl" type="url" value="${esc(p.filmUrl)}" placeholder="https://www.hudl.com/video/…"><span class="small">Plays first on the card. No reel yet? <a href="#/highlights">Get one made</a>.</span></div>
      ${videoRows.map((v, i) => `<div class="video-row">
        <div class="two">
          <div class="field"><label for="${id}-vt${i}">Video ${i + 2} title</label><input id="${id}-vt${i}" name="videos.${i}.title" maxlength="80" value="${esc(v.title)}" placeholder="${i === 0 ? 'vs. Chesapeake Elite, full game' : 'Fall ball 2026'}"></div>
          <div class="field"><label for="${id}-vk${i}">Type</label><select id="${id}-vk${i}" name="videos.${i}.kind">${options(VIDEO_KINDS, v.kind || (i === 0 ? 'game' : 'highlight'))}</select></div>
        </div>
        <div class="field"><label for="${id}-vu${i}">Link</label><input id="${id}-vu${i}" name="videos.${i}.url" type="url" value="${esc(v.url)}" placeholder="https://"></div>
      </div>`).join('')}
      ${videoRows.length < 8 ? '<p class="small">Save to get room for another video.</p>' : ''}
    </fieldset>` : ''}

    <p id="${id}-msg" role="status" aria-live="polite"></p>
    <button class="btn btn-primary btn-block" type="submit">${esc(submitLabel)}</button>
  </form>`;
}

/** Clean the raw form object into what addPlayer / updatePlayer expect. */
export function cleanPlayerInput(raw) {
  const out = { ...raw };
  if (out.rankings) {
    out.rankings = Object.values(out.rankings).filter((r) => r && (r.source || r.value || r.url))
      .map((r) => ({ source: r.source, value: r.value, url: r.url || null }));
  }
  if (out.videos) {
    out.videos = Object.values(out.videos).filter((v) => v && (v.url || v.title))
      .map((v) => ({ title: v.title || null, url: v.url || null, kind: v.kind || 'other' }));
  }
  if (out.stats) {
    const s = {}; for (const [k, v] of Object.entries(out.stats)) if (v !== null && v !== undefined) s[k] = v;
    out.stats = s;
  }
  return out;
}

/** Basic checks before calling the server, so the message appears instantly. */
export function quickCheck(p) {
  if (!p.firstName) return 'Enter a first name.';
  if (!p.lastName) return 'Enter a last name.';
  if (!p.gradYear) return 'Choose a grad year.';
  if (!p.position) return 'Choose a position.';
  if (!p.openDivisions || !p.openDivisions.length) return 'Pick at least one division.';
  if (p.academics?.gpa != null && (Number.isNaN(p.academics.gpa) || p.academics.gpa < 0 || p.academics.gpa > (p.academics.gpaScale || 4))) return 'GPA must be between 0 and the GPA scale.';
  return null;
}

/** When the sport changes, swap the position list without losing other edits. */
export function bindSportSwitch(formId) {
  const form = document.getElementById(formId);
  const sport = form?.elements.sport; const pos = form?.elements.position;
  if (!sport || !pos) return;
  sport.addEventListener('change', () => {
    const keep = pos.value;
    pos.innerHTML = options(POSITIONS[sport.value], keep, { blank: 'Choose' });
  });
}
