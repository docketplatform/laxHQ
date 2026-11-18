// Makes a login a platform admin (sees the Admin area: every family, highlight requests,
// highlight partner settings), or removes that.
//
//   ADMIN_EMAIL=you@example.com GCLOUD_PROJECT=laxhq-ce7b7 node scripts/platform-admin.mjs grant
//
// Run it from GitHub: Actions → Platform admin → Run workflow. The person must have signed in once.
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-laxhq' });
const mode = process.argv[2];
const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const fail = (m) => { console.error(`::error::${m}`); process.exit(1); };

if (!['grant', 'revoke'].includes(mode)) fail('Say grant or revoke.');
let user;
try { user = await getAuth().getUserByEmail(email); } catch { fail('No LaxHQ login uses that email yet. Sign in once, then run this again.'); }
const ref = getFirestore().doc(`admins/${user.uid}`);
if (mode === 'grant') await ref.set({ email, grantedAt: FieldValue.serverTimestamp() });
else await ref.delete();
console.log(mode === 'grant' ? 'That login is now a platform admin. Reload the app to see Admin.' : 'Admin access removed.');
