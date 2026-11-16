// Onboarding: set up a player. Free accounts can fill it in; it's kept in this browser
// and saved automatically the moment the family has Pro.
import { $, esc, safeStorage, formToObject, errorText } from '../util.js';
import { playerFormHtml, cleanPlayerInput, quickCheck, bindSportSwitch } from './playerForm.js';

const DRAFT_KEY = 'laxhq.draftPlayer';
export const getDraft = () => safeStorage.getJSON(DRAFT_KEY);
const clearDraft = () => safeStorage.del(DRAFT_KEY);

let submitting = false;
/** Called by the app whenever players load: a Pro family with no player saves the kept draft. */
export async function maybeSubmitDraft(ctx) {
  const draft = getDraft();
  if (!draft || submitting || !ctx.isPro() || ctx.state.players.length) return;
  submitting = true;
  try { await ctx.call('addPlayer', draft); clearDraft(); ctx.navigate('#/home'); } catch (e) {
    ctx.setUi('onboardingMsg', { text: errorText(e), bad: true });
  } finally { submitting = false; }
}

export default {
  tab: 'home',
  render(ctx) {
    const sibling = ctx.state.players.length > 0;
    const draft = sibling ? {} : (getDraft() || {});
    const lastName = sibling ? ctx.state.players[0].lastName : draft.lastName;
    const msg = ctx.state.ui.onboardingMsg;
    let intro;
    if (!ctx.isPro()) {
      intro = `<div class="banner"><span><b>Fill this in now, save it with Pro.</b>Your answers stay in this browser and are saved the moment you start Pro, so nothing is retyped.</span></div>`;
    } else if (sibling && !ctx.can('addPlayer')) {
      intro = `<div class="banner"><span><b>Your plan covers ${ctx.state.family?.entitlement?.maxPlayers || 1} player${(ctx.state.family?.entitlement?.maxPlayers || 1) > 1 ? 's' : ''}.</b>Add a sibling to your plan (+$99/year) to set up another player.</span></div>`;
    } else intro = '';
    return `<a class="back" href="#/${sibling ? 'profile' : 'home'}">← Back</a>
      <h1>${sibling ? 'Add a sibling' : 'Set up your player'}</h1>
      <p class="muted">Takes about two minutes. You can add stats, rankings and film later on the Profile tab.</p>
      ${intro}
      ${msg ? `<p class="${msg.bad ? 'err' : 'ok'}" role="status">${esc(msg.text)}</p>` : ''}
      ${playerFormHtml({ ...draft, lastName }, { id: 'onboard', submitLabel: ctx.isPro() ? 'Save player' : 'Keep my answers' })}`;
  },
  bind(ctx) {
    bindSportSwitch('onboard');
    $('onboard').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('onboard-msg');
      const data = cleanPlayerInput(formToObject(e.target));
      const problem = quickCheck(data);
      if (problem) { msg.className = 'err'; msg.textContent = problem; return; }
      if (!ctx.isPro()) {
        safeStorage.setJSON(DRAFT_KEY, data);
        msg.className = 'ok';
        msg.innerHTML = 'Saved in this browser. <a href="#/profile">Start Pro on the Profile tab</a> and it’s added to your account automatically.';
        return;
      }
      if (ctx.state.players.length && !ctx.can('addPlayer')) { msg.className = 'err'; msg.textContent = 'Add a sibling to your plan first.'; return; }
      e.submitter.disabled = true; msg.className = 'small'; msg.textContent = 'Saving…';
      try {
        const { playerId } = await ctx.call('addPlayer', data);
        if (!ctx.state.players.length) clearDraft();
        ctx.selectPlayer(playerId);
        ctx.navigate('#/home');
      } catch (err) {
        e.submitter.disabled = false; msg.className = 'err'; msg.textContent = errorText(err);
      }
    });
  },
};
