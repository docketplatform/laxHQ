// Screen registry for the router. Each screen: { render(ctx, args) → html, bind?(ctx, args), tab? }.
import home from './home.js';
import plan from './plan.js';
import onboarding from './onboarding.js';
import profile from './profile.js';
import schools from './schools.js';
import coaches from './coaches.js';
import events from './events.js';
import spend from './spend.js';
import highlights from './highlights.js';
import admin from './admin.js';

export const views = {
  home,
  plan,
  onboarding,
  profile,
  schools,
  coaches,
  events,
  spend,
  highlights,
  admin,
};
