// Emulator-only settings for Cloud Functions. Adds any missing lines; never overwrites yours.
//   functions/.secret.local – placeholder secrets (the local mocks ignore them)
//   functions/.env.local    – points the Anthropic and Stripe clients at local mocks, test price ids
// Both files are gitignored and never deployed. To call the real services locally, put real
// values in these files (and remove the *_HOST / BASE_URL lines).
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { MOCK_PORT } from './mock-anthropic.mjs';

export const STRIPE_MOCK_PORT = 12111;

function ensure(file, lines) {
  const have = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = lines.filter((l) => !new RegExp(`^${l.split('=')[0]}=`, 'm').test(have));
  if (missing.length) appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

ensure('functions/.secret.local', [
  'ANTHROPIC_API_KEY=emulator-placeholder',
  'STRIPE_SECRET_KEY=sk_test_emulator',
  'STRIPE_WEBHOOK_SECRET=whsec_emulator',
  'REVENUECAT_WEBHOOK_AUTH=rc_emulator',
]);
ensure('functions/.env.local', [
  `ANTHROPIC_BASE_URL=http://127.0.0.1:${MOCK_PORT}`,
  'STRIPE_API_HOST=127.0.0.1',
  `STRIPE_API_PORT=${STRIPE_MOCK_PORT}`,
  'STRIPE_API_PROTOCOL=http',
  'STRIPE_PRICE_PRO_YEAR=price_pro_year',
  'STRIPE_PRICE_PRO_MONTH=price_pro_month',
  'STRIPE_PRICE_SIBLING_YEAR=price_sibling_year',
]);
