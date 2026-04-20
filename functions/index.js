const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin  = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();

const LEMON_SECRET = defineSecret('LEMON_SECRET');

// ── LemonSqueezy webhook ──────────────────────────────────────────────────────
// Set your LemonSqueezy webhook secret:
//   firebase functions:secrets:set LEMON_SECRET
//
// In LemonSqueezy dashboard → Settings → Webhooks:
//   URL:    https://us-central1-firebasics-99c9b.cloudfunctions.net/lemonWebhook
//   Events: order_created, subscription_created, subscription_updated,
//           subscription_cancelled, subscription_expired

exports.lemonWebhook = onRequest({ secrets: [LEMON_SECRET] }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // Verify webhook signature
  const secret    = LEMON_SECRET.value();
  const signature = req.headers['x-signature'];
  const hmac      = crypto.createHmac('sha256', secret)
                          .update(JSON.stringify(req.body))
                          .digest('hex');

  if (signature !== hmac) {
    console.warn('LemonSqueezy webhook: invalid signature');
    return res.status(401).send('Unauthorized');
  }

  const eventName = req.body.meta?.event_name;
  const uid       = req.body.meta?.custom_data?.uid;

  if (!uid) {
    console.warn('LemonSqueezy webhook: no uid in custom_data');
    return res.status(400).send('Missing uid');
  }

  const ref = admin.database().ref(`users/${uid}/meta/tier`);

  if (
    eventName === 'order_created' ||
    eventName === 'subscription_created' ||
    eventName === 'subscription_updated'
  ) {
    // Payment successful — upgrade to pro
    await ref.set('pro');
    console.log(`Upgraded user ${uid} to pro`);
  } else if (
    eventName === 'subscription_cancelled' ||
    eventName === 'subscription_expired'
  ) {
    // Subscription ended — downgrade to free
    await ref.set('free');
    console.log(`Downgraded user ${uid} to free`);
  }

  res.status(200).send('OK');
});
