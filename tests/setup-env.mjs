// Writes emulator-only settings for Cloud Functions if they don't exist yet:
//   functions/.secret.local  – a placeholder ANTHROPIC_API_KEY (the mock ignores it)
//   functions/.env.local     – ANTHROPIC_BASE_URL pointing at the local mock API
// Both files are gitignored and are never deployed. Delete .env.local to use the real API locally
// (and put your real key in .secret.local).
import { existsSync, writeFileSync } from 'node:fs';
import { MOCK_PORT } from './mock-anthropic.mjs';

if (!existsSync('functions/.secret.local')) writeFileSync('functions/.secret.local', 'ANTHROPIC_API_KEY=emulator-placeholder\n');
if (!existsSync('functions/.env.local')) writeFileSync('functions/.env.local', `ANTHROPIC_BASE_URL=http://127.0.0.1:${MOCK_PORT}\n`);
