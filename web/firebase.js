// Firebase setup shared by every module. On localhost (or ?emulator) the app uses the emulators.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';
import { getStorage, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';

// Real projects: replace with the web app config from the Firebase console
// (Project settings → Your apps). These values are public by design.
const FIREBASE_CONFIG = {
  apiKey: 'REPLACE_ME',
  authDomain: 'laxhq-dev.firebaseapp.com',
  projectId: 'laxhq-dev',
  storageBucket: 'laxhq-dev.appspot.com',
  appId: 'REPLACE_ME',
};

export const params = new URLSearchParams(location.search);
export const USE_EMULATORS = ['localhost', '127.0.0.1'].includes(location.hostname) || params.has('emulator');

const config = USE_EMULATORS
  ? { apiKey: 'demo-key', authDomain: 'demo-laxhq.firebaseapp.com', projectId: 'demo-laxhq', storageBucket: 'demo-laxhq.appspot.com' }
  : FIREBASE_CONFIG;

export const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const fns = getFunctions(app, 'us-central1');
export const storage = getStorage(app);
export const PROJECT_ID = config.projectId;

// App Check (reCAPTCHA Enterprise). Add the site key from Firebase console → App Check, then set
// ENFORCE_APP_CHECK=true for Cloud Functions. Skipped on the emulators.
const APP_CHECK_SITE_KEY = '';
if (APP_CHECK_SITE_KEY && !USE_EMULATORS) {
  import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js').then(({ initializeAppCheck, ReCaptchaEnterpriseProvider }) => {
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
  }).catch((e) => console.error('App Check', e));
}

if (USE_EMULATORS) {
  const host = params.get('emulatorHost') || '127.0.0.1';
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectFunctionsEmulator(fns, host, 5001);
  connectStorageEmulator(storage, host, 9199);
}

/** Call a callable Cloud Function and return its data. Errors carry the server's message. */
export const call = (name, data = {}) => httpsCallable(fns, name)(data).then((r) => r.data);

/** Base URL for HTTPS (non-callable) functions such as the card view endpoint. */
export const functionsBase = USE_EMULATORS
  ? `http://${params.get('emulatorHost') || '127.0.0.1'}:5001/${config.projectId}/us-central1`
  : '/api';
