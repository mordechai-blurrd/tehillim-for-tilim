/**
 * webpush.js
 * Sends Web Push notifications via Firebase Cloud Messaging (FCM).
 * firebase-admin handles the server-side send; the browser uses the
 * Firebase JS SDK to subscribe and pass us an FCM token.
 */

require('dotenv').config();
const db = require('./db');

let messaging = null;

try {
  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_PRIVATE_KEY &&
    process.env.FIREBASE_CLIENT_EMAIL
  ) {
    const admin = require('firebase-admin');
    const app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    messaging = admin.messaging(app);
    console.log('[Push] Firebase Admin initialized ✓');
  } else {
    console.warn('[Push] Firebase not configured — push notifications disabled');
  }
} catch (e) {
  console.warn('[Push] Firebase init failed:', e.message);
}

async function dispatch(alertPayload) {
  const tokens = db.getAllPushTokens();
  if (!tokens.length) return { sent: 0, failed: 0 };

  const areas   = (alertPayload.areas || []).slice(0, 5).join(', ') || 'Israel';
  const body    = `Rockets detected near ${areas}. Stop and say Tehillim now.`;
  const link    = process.env.BASE_URL || 'https://tehillimfortilim.com';

  if (!messaging) {
    console.log(`[Push DRY RUN] Would send to ${tokens.length} token(s): ${body}`);
    return { sent: 0, failed: 0 };
  }

  const message = {
    notification: {
      title: '🚨 Red Alert — Say Tehillim Now',
      body,
    },
    webpush: {
      notification: {
        icon:                '/icon-192.png',
        requireInteraction:  true,
        vibrate:             [300, 100, 300, 100, 300],
      },
      fcmOptions: { link },
    },
    tokens,
  };

  const response = await messaging.sendEachForMulticast(message);

  // Prune invalid/expired tokens so they don't pile up
  const dead = tokens.filter((_, i) => !response.responses[i].success);
  if (dead.length) {
    db.removePushTokens(dead);
    console.log(`[Push] Pruned ${dead.length} expired token(s)`);
  }

  console.log(`[Push] Sent: ${response.successCount} Failed: ${response.failureCount}`);
  return { sent: response.successCount, failed: response.failureCount };
}

module.exports = { dispatch, isConfigured: () => !!messaging };
