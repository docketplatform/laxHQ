# LaxHQ

The college recruiting game plan for lacrosse families. A vanilla-JS web app (no build step) on Firebase: Auth, Firestore, Cloud Functions, Storage. Billing through Stripe (web) and RevenueCat (iOS). AI drafting and receipt reading through the Claude API.

The product plan lives in the LaxHQ MVP Plan doc. This repo implements every MVP phase.

## What's built

| Area | What families get | Main code |
|---|---|---|
| Accounts & families | Google, Apple or email-link sign-in; families with invite links for a co-parent and the player; free = view-only sample family, Pro = save everything | `functions/index.js`, `web/app.js` |
| Plan | Sept 1 countdown, grade-by-grade checklist with check-off, skip and custom tasks, readiness | `web/lib/plan.js`, `web/views/home.js`, `plan.js` |
| Profile | Player profile (school, grades, club, honors, rankings, stats, film), siblings | `functions/lib/player.js`, `web/views/profile.js` |
| Schools | Catalog search, custom schools, athletic + academic fit, balance warnings, "How you compare", status, notes, questionnaire links, commitment sharing | `web/lib/fit.js`, `web/views/schools.js` |
| Recruiting card | Public `/c/<code>` page, first name + last initial only, view tracking with per-coach links, PDF | `functions/card.js`, `web/views/card.js` |
| Coaches | Pipeline, rule check, AI-drafted emails sent from the family's own inbox, follow-up reminders, family-confirmed coach directory | `functions/coaches.js`, `web/views/coaches.js` |
| Summer & club schedule | Club calendar import (TeamSnap, SportsEngine, LeagueApps, Google), one sync per team, clash alerts, summer events | `functions/schedule.js`, `functions/lib/ics.js`, `web/views/events.js` |
| Spending | Every recruiting dollar: manual, receipt scan, planned event costs, LaxHQ's own charges; season/category/month/player totals, budget, CSV | `web/lib/expenses.js`, `functions/expenses.js`, `web/views/spend.js` |
| Billing | Stripe Checkout ($500/yr, $49/mo, $99/yr siblings), Customer Portal, webhooks, RevenueCat for iOS | `functions/billing.js` |
| Launch | Self-serve account deletion, daily backups, App Check, help/privacy/terms pages | `functions/account.js`, `web/*.html` |

## Layout

```
web/                     the app (served as static files)
  index.html             shell, styles
  app.js                 sign-in, session, live data, router
  firebase.js            Firebase setup (emulators on localhost), App Check
  views/*.js             one module per screen
  lib/*.js               pure logic shared with the tests (plan, fit, expenses, options)
  help.html privacy.html terms.html static.css
functions/               Cloud Functions (Node 20)
  index.js               families, invites, players, claims; wires the modules below
  card.js coaches.js schedule.js expenses.js billing.js account.js
  lib/                   player validation, iCalendar parsing, safe fetching, overlaps
firestore.rules storage.rules firestore.indexes.json
data/schools.json        starter catalog of 41 programs (verify before launch)
scripts/                 seed config, seed schools, import College Scorecard data
tests/                   unit, rules, functions (emulator) and browser (Playwright) tests
.github/workflows/ci.yml runs every test on each push; deploys to dev once configured
netlify.toml             serves web/ and proxies /api/* to Cloud Functions
```

## Run it locally

Needs Node 20+ and Java 17+ (for the emulators).

```bash
npm install
```

```bash
npm install --prefix functions
```

```bash
npm run emulators
```

In a second terminal, seed the config and the school catalog:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run seed
```

Open http://127.0.0.1:5000. On localhost the app uses the emulators and shows an "Emulator sign-in" form, and the Profile tab has emulator-only buttons to switch between Free and Pro. Emulator UI: http://127.0.0.1:4000.

`npm run emulators` writes `functions/.env.local` and `functions/.secret.local` (both gitignored) pointing the Claude and Stripe clients at local mocks. To try real AI drafts locally, put a real `ANTHROPIC_API_KEY` in `.secret.local` and delete the `ANTHROPIC_BASE_URL` line from `.env.local`.

## Tests

```bash
npm test
```

| Suite | Command | What it covers |
|---|---|---|
| Unit | `npm run test:unit` | Checklist engine, fit, expenses, feed parsing, overlaps, card projection, billing state, validation |
| Rules | `npm run test:rules` | Every collection's security rules, Storage rules |
| Functions | `npm run test:functions` | Every Cloud Function against the emulators, with mock Claude, Stripe and calendar servers |
| Browser | `npm run test:e2e` | Seven end-to-end scenarios in Chromium covering every screen |

The browser tests need Playwright's Chromium (`npx playwright install chromium`). No real API keys are used by any test.

## Going live

### 1. Firebase

1. Create projects `laxhq-dev` and `laxhq-prod`. Upgrade to the Blaze plan (needed for Cloud Functions and outbound requests).
2. Enable Firestore, Storage, and Authentication with the Google, Apple and Email link providers. Add your web domain under Authentication → Settings → Authorized domains.
3. Put the web app config (Project settings → Your apps) into `FIREBASE_CONFIG` in `web/firebase.js`, and add the projects to `.firebaserc`.
4. Secrets (stored in Google Secret Manager):

   ```bash
   firebase functions:secrets:set ANTHROPIC_API_KEY --project laxhq-prod
   ```

   Repeat for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `REVENUECAT_WEBHOOK_AUTH`.
5. Non-secret settings in `functions/.env.laxhq-prod` (commit this file): `STRIPE_PRICE_PRO_YEAR`, `STRIPE_PRICE_PRO_MONTH`, `STRIPE_PRICE_SIBLING_YEAR`, `BACKUP_BUCKET`, and `ENFORCE_APP_CHECK=true` once App Check is set up.
6. Deploy:

   ```bash
   npx firebase deploy --project laxhq-prod --only firestore,storage,functions
   ```

7. Seed config and schools once (`GOOGLE_APPLICATION_CREDENTIALS=key.json GCLOUD_PROJECT=laxhq-prod npm run seed`). Verify every rule in `scripts/seed-config.mjs` against ncaa.org and every program in `data/schools.json` first. To load admit rates and SAT/ACT ranges, get a free key at api.data.gov and run `SCORECARD_API_KEY=… node scripts/import-scorecard.mjs`.

### 2. Web hosting (Netlify)

Create a second Netlify site for the app (the marketing page stays on laxhq.netlify.app). Point it at this repo; `netlify.toml` publishes `web/`. Replace `PROJECT_ID` in `netlify.toml` with your Firebase project id so `/api/*` reaches Cloud Functions (the card view counter uses it).

### 3. Stripe

1. Create a product "LaxHQ Pro" with prices $500/year and $49/month, and a product "Sibling add-on" at $99/year. Put the three price ids in `functions/.env.<project>`.
2. Turn on the Customer Portal (Settings → Billing → Customer portal): allow plan switching between the two Pro prices, quantity changes for the sibling add-on, payment method updates, invoice history and cancellation.
3. Add a webhook endpoint `https://us-central1-<project>.cloudfunctions.net/stripeWebhook` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.paid`. Save its signing secret as `STRIPE_WEBHOOK_SECRET`.
4. Turn on Smart Retries and the customer emails for failed payments (Settings → Billing → Revenue recovery).

### 4. RevenueCat (when the iOS app ships)

Configure the app's `app_user_id` as the family id, add a webhook to `…/revenuecatWebhook`, and set its Authorization header to `Bearer <REVENUECAT_WEBHOOK_AUTH>`.

### 5. Backups, monitoring and App Check

- Backups: create a bucket, set `BACKUP_BUCKET`, give the default compute service account "Cloud Datastore Import Export Admin" plus write access to the bucket, and add a lifecycle rule deleting objects after 30 days.
- Alerts: in Cloud Monitoring, alert on Cloud Functions error rate, and set a spend limit and alert in the Anthropic Console.
- App Check: register the web app with reCAPTCHA Enterprise, put the site key in `APP_CHECK_SITE_KEY` in `web/firebase.js`, deploy, then set `ENFORCE_APP_CHECK=true`.

### 6. CI deploys

`.github/workflows/ci.yml` runs every suite on each push. To deploy to dev from `main`, add a service account key as the GitHub secret `FIREBASE_SERVICE_ACCOUNT` and set the repository variable `FIREBASE_PROJECT` to `laxhq-dev`.

## Before launch: still to do by a person

- Have a lawyer review and complete `web/privacy.html` and `web/terms.html` (they're drafts).
- Verify NCAA rules (`scripts/seed-config.mjs`) and the school catalog (`data/schools.json`).
- Check the calendar-link help text against real TeamSnap, SportsEngine and LeagueApps accounts, and test imports with real feeds.
- Run a test purchase in Stripe test mode end to end on the dev project.
