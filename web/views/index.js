// Screen registry for the router. Each screen: { render(ctx, args) → html, bind?(ctx, args), tab? }.
import home from './home.js';
import plan from './plan.js';
import onboarding from './onboarding.js';
import profile from './profile.js';
import schools from './schools.js';
import { sampleViews } from './sample.js';

/** Placeholder for Pro screens that arrive in later phases. */
const later = (title, what) => ({
  render(ctx) {
    if (!ctx.isPro() || !ctx.currentPlayer()) return sampleViews[title.key]();
    return `<h1>${title.text}</h1><div class="card"><p class="muted">${what}</p></div>`;
  },
});

export const views = {
  home,
  plan,
  onboarding,
  profile,
  schools,
  coaches: later({ key: 'coaches', text: 'Coach outreach' }, 'Your coach pipeline arrives in a later build.'),
  events: later({ key: 'events', text: 'Summer plan' }, 'Your summer plan arrives in a later build.'),
};
