// Expense tracker (Phase 5): read a receipt photo with Claude so the family only has to confirm.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const AnthropicSDK = require('@anthropic-ai/sdk');

const Anthropic = AnthropicSDK.default || AnthropicSDK;
const db = getFirestore();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const MODEL = 'claude-opus-5-5';
const SCANS_PER_MONTH = 100;
const CATEGORIES = ['club_dues', 'tournaments', 'camps', 'travel', 'hotels', 'meals', 'equipment', 'highlights', 'services', 'training', 'testing', 'other'];

let helpers = null;
function init(h) { helpers = h; }
const monthKey = (d = new Date()) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    amount: { type: 'string', description: 'Total paid, digits and a decimal point only (e.g. "412.36"); empty if unreadable.' },
    date: { type: 'string', description: 'Date of the charge as YYYY-MM-DD; empty if unreadable.' },
    payee: { type: 'string', description: 'Business or organization paid; empty if unreadable.' },
    category: { type: 'string', enum: [...CATEGORIES, 'unknown'] },
  },
  required: ['amount', 'date', 'payee', 'category'],
  additionalProperties: false,
};

const RECEIPT_PROMPT = `Read this receipt from a family's youth lacrosse recruiting spending.
Return the total amount actually paid (after tax and tips, not a subtotal), the charge date, and who was paid.
Pick the category that fits best: club_dues (club team fees), tournaments (tournaments, showcases), camps (college camps, prospect days, clinics), travel (gas, flights, tolls, parking, rental cars), hotels, meals, equipment, highlights (highlight video editing), services (recruiting platforms and apps), training (private lessons, strength training), testing (SAT/ACT, application fees), other.
Leave a field empty, or use "unknown" for category, when you can't read it. Don't guess.`;

/** Clean the model's answer into form values. Pure; unit tested. */
function cleanReceipt(raw) {
  const amount = /^\d+(\.\d{1,2})?$/.test(String(raw.amount || '').replace(/[$,\s]/g, '')) ? String(raw.amount).replace(/[$,\s]/g, '') : null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') && !Number.isNaN(Date.parse(raw.date)) ? raw.date : null;
  return {
    amount, date,
    payee: raw.payee ? String(raw.payee).trim().slice(0, 100) || null : null,
    category: CATEGORIES.includes(raw.category) ? raw.category : null,
  };
}

/**
 * scanReceipt — read a receipt the family uploaded to receipts/{fid}/….
 * data: { path } → { amount, date, payee, category } (any can be null)
 */
const scanReceipt = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120 }, async (req) => {
  const { fid } = await helpers.requireProFamily(req);
  const path = String(req.data?.path || '');
  if (!path.startsWith(`receipts/${fid}/`) || path.includes('..')) throw new HttpsError('invalid-argument', 'That receipt was not found.');
  const file = getStorage().bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', 'That receipt was not found.');
  const [meta] = await file.getMetadata();
  const type = meta.contentType || '';
  if (!/^image\/(jpeg|png|gif|webp)$/.test(type) && type !== 'application/pdf') {
    throw new HttpsError('invalid-argument', 'Use a JPG, PNG or PDF receipt.');
  }
  if (Number(meta.size) > 10 * 1024 * 1024) throw new HttpsError('invalid-argument', 'That file is too large.');

  const usageRef = db.doc(`usage/${fid}_${monthKey()}`);
  await db.runTransaction(async (tx) => {
    const u = await tx.get(usageRef);
    const n = (u.exists && u.get('receiptScans')) || 0;
    if (n >= SCANS_PER_MONTH) throw new HttpsError('resource-exhausted', 'You’ve scanned the maximum receipts this month. Add the rest by hand.');
    tx.set(usageRef, { receiptScans: n + 1, fid, month: monthKey() }, { merge: true });
  });

  try {
    const [buf] = await file.download();
    const data = buf.toString('base64');
    const block = type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: type, data } };
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
      messages: [{ role: 'user', content: [block, { type: 'text', text: RECEIPT_PROMPT }] }],
    });
    if (response.stop_reason === 'refusal') throw new HttpsError('failed-precondition', 'LaxHQ couldn’t read that receipt. Add it by hand.');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let raw;
    try { raw = JSON.parse(text); } catch { throw new HttpsError('internal', 'LaxHQ couldn’t read that receipt. Add it by hand.'); }
    return cleanReceipt(raw);
  } catch (e) {
    await usageRef.set({ receiptScans: FieldValue.increment(-1) }, { merge: true }).catch(() => {});
    if (e instanceof HttpsError) throw e;
    if (e instanceof Anthropic.APIError) throw new HttpsError('unavailable', 'Receipt reading is unavailable right now. Add it by hand.');
    throw e;
  }
});

module.exports = { init, scanReceipt, cleanReceipt, RECEIPT_SCHEMA };
