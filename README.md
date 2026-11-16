# LaxHQ

A college recruiting game plan for lacrosse families. Single-file web app (vanilla JS) on Firebase: Auth, Firestore, Cloud Functions and Storage.

The full product plan, data model and build order live in the LaxHQ MVP Plan doc. This repo follows it phase by phase.

## Status: Phase 0 (foundations)

- Sign in with Google, Apple or an email link
- First sign-in creates a family; invite links add a co-parent or the player
- Custom claims `fid` and `pro` on every member's token, so security rules need no extra reads
- Free accounts are view-only and browse a sample family; saving anything needs Pro
- Security rules for every collection in the plan, including expenses and receipts
- Config seed: NCAA contact rules, checklist template, plan limits and prices
- Tests: 22 security rules tests, 6 function tests, and a browser test of sign-up → invite → shared family

## Layout

```
web/index.html            the app (one file; Firebase SDK from the gstatic CDN)
functions/index.js        Cloud Functions: bootstrapFamily, createInvite, acceptInvite, updateMyName, refreshMyClaims
firestore.rules           Firestore security rules
storage.rules             Storage rules (receipts)
firestore.indexes.json    composite indexes
scripts/seed-config.mjs   seeds config/ncaaRules, config/checklist, config/plans
tests/                    rules, functions and browser (Playwright) tests
.github/workflows/ci.yml  runs every test on each push; deploys to dev once configured
```

## Run it locally

Needs Node 20+ and Java 17+ (for the Firestore emulator).

```bash
npm install
```

```bash
npm install --prefix functions
```

```bash
npm run emulators
```

Then, in a second terminal, seed the config docs:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run seed
```

Open http://127.0.0.1:5000. On localhost the app talks to the emulators and shows an "Emulator sign-in" form. The emulator UI is at http://127.0.0.1:4000.

## Tests

```bash
npm test
```

This runs `test:rules`, `test:functions` and `test:e2e`. Each starts the emulators it needs and stops them afterwards. The browser test needs Playwright's Chromium (`npx playwright install chromium`).

## Connecting a real Firebase project

1. Create `laxhq-dev` (and later `laxhq-prod`) in the Firebase console. Enable Firestore, Storage, and Authentication with the Google, Apple and Email link providers. Functions need the Blaze plan.
2. Put the web app config from Project settings → Your apps into `FIREBASE_CONFIG` in `web/index.html`.
3. Add the projects to `.firebaserc`.
4. For automatic deploys, create a service account with the Firebase Admin role. Save its JSON key as the GitHub secret `FIREBASE_SERVICE_ACCOUNT`, and set the repository variable `FIREBASE_PROJECT` to `laxhq-dev`.
5. Seed config once: `GOOGLE_APPLICATION_CREDENTIALS=key.json GCLOUD_PROJECT=laxhq-dev npm run seed`.

Before seeding production, verify every rule in `scripts/seed-config.mjs` against ncaa.org.
