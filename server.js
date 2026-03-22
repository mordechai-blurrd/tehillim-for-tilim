/**
 * server.js
 * Tehillim for Tilim — Backend Server
 *
 * Routes:
 *   GET  /api/status          — Current alert status + subscriber count
 *   POST /api/subscribe       — Sign up for notifications
 *   POST /api/push-token      — Save FCM push token for a subscriber
 *   GET  /firebase-config.js  — Public Firebase client config (served as JS)
 *   GET  /unsubscribe/:id     — One-click unsubscribe
 *   GET  /api/admin           — Admin view (subscriber list + alert log)
 *   POST /api/test-alert      — Manually trigger a test alert (dev only)
 *   WS   /ws                  — WebSocket: push alert/clear events to browser
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const http       = require('http');
const { WebSocketServer } = require('ws');

const poller     = require('./alertPoller');
const db         = require('./db');
const { dispatch, sendWelcome } = require('./notifier');

// Twilio client for inbound webhook replies
let twilioClient;
try {
  if (process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.startsWith('ACx')) {
    twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
} catch (e) { /* notifier.js will log the warning */ }

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

const PORT   = process.env.PORT || 3000;
const IS_DEV = process.env.NODE_ENV !== 'production';

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // for Twilio webhook (form-encoded)
app.use(express.static(path.join(__dirname, 'public')));

// ── Alert Log (in-memory, last 50 events) ─────────────────
const alertLog = [];
function logAlert(type, payload) {
  alertLog.unshift({ type, payload, ts: new Date().toISOString() });
  if (alertLog.length > 50) alertLog.pop();
}

// ── WebSocket: broadcast to all connected clients ─────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  console.log(`[WS] Client connected (total: ${wss.clients.size})`);
  ws.send(JSON.stringify({
    event: 'status',
    data:  { ...poller.getStatus(), subscribers: db.count() + COUNT_SEED },
    ts:    new Date().toISOString(),
  }));
  ws.on('close', () => console.log(`[WS] Client disconnected (total: ${wss.clients.size})`));
});

// ── Poller event handlers ─────────────────────────────────

// Server-level dedup: belt-and-suspenders guard against the poller emitting
// the same alert twice (e.g. tzevaadom returning a slightly different time field).
let _lastDispatchId   = null;
let _lastDispatchTime = 0;
let _lastDispatchAreas = '';

poller.on('alert', async (payload) => {
  const now      = Date.now();
  const areaKey  = [...(payload.areas || [])].sort().join(',');
  const sameId   = payload.id === _lastDispatchId;
  const sameArea = areaKey === _lastDispatchAreas && (now - _lastDispatchTime) < 180_000;

  if (sameId || sameArea) {
    console.log(`[Server] Duplicate alert suppressed (id=${payload.id})`);
    return;
  }

  _lastDispatchId    = payload.id;
  _lastDispatchTime  = now;
  _lastDispatchAreas = areaKey;

  logAlert('alert', payload);
  broadcast('alert', payload);

  const stats = await dispatch(payload);
  broadcast('dispatch_stats', stats);
});

poller.on('clear', () => {
  logAlert('clear', {});
  broadcast('clear', { message: 'All clear' });
});

// ── REST API ──────────────────────────────────────────────

const COUNT_SEED = parseInt(process.env.SUBSCRIBER_COUNT_SEED) || 0;

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    ...poller.getStatus(),
    subscribers: db.count() + COUNT_SEED,
    wsClients:   wss.clients.size,
    uptime:      process.uptime(),
  });
});

// GET /firebase-config.js — serves public Firebase client config as a JS file
// Imported by firebase-messaging-sw.js (service worker) via importScripts.
app.get('/firebase-config.js', (req, res) => {
  res.type('application/javascript');
  res.send(
    `self.FIREBASE_CONFIG=${JSON.stringify({
      apiKey:            process.env.FIREBASE_API_KEY            || '',
      authDomain:        process.env.FIREBASE_AUTH_DOMAIN        || '',
      projectId:         process.env.FIREBASE_PROJECT_ID         || '',
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
      appId:             process.env.FIREBASE_APP_ID             || '',
    })};self.FIREBASE_VAPID_KEY=${JSON.stringify(process.env.FIREBASE_VAPID_KEY || '')};`
  );
});

// POST /api/subscribe
app.post('/api/subscribe', async (req, res) => {
  const { name, method, email, phone, whatsapp } = req.body;

  const VALID_METHODS = [
    'email', 'sms', 'whatsapp', 'push',
    'sms_whatsapp', 'email_sms', 'email_whatsapp', 'email_push',
    'whatsapp_push', 'email_whatsapp_push', 'all',
  ];
  const needsEmail = m => ['email','email_sms','email_whatsapp','email_push','email_whatsapp_push','all'].includes(m);
  const needsPhone = m => ['sms','sms_whatsapp','email_sms','all'].includes(m);
  const needsWA    = m => ['whatsapp','sms_whatsapp','email_whatsapp','whatsapp_push','email_whatsapp_push','all'].includes(m);

  if (!name || typeof name !== 'string' || name.trim().length < 1)
    return res.status(400).json({ ok: false, error: 'Name is required.' });
  if (!VALID_METHODS.includes(method))
    return res.status(400).json({ ok: false, error: 'Invalid notification method.' });
  if (needsEmail(method) && !isValidEmail(email))
    return res.status(400).json({ ok: false, error: 'Valid email address required.' });
  if (needsPhone(method) && (!phone || phone.trim().length < 7))
    return res.status(400).json({ ok: false, error: 'Valid phone number required for SMS.' });
  const waNumber = whatsapp || phone;
  if (needsWA(method) && (!waNumber || waNumber.trim().length < 7))
    return res.status(400).json({ ok: false, error: 'Valid phone number required for WhatsApp.' });

  const result = db.add({ name, method, email, phone: phone || null, whatsapp: waNumber || null });

  if (!result.ok && result.error === 'already_exists')
    return res.status(409).json({ ok: false, error: 'You\'re already signed up!' });

  const sub = db.all().find(s => s.id === result.id);
  if (sub) sendWelcome(sub).catch(() => {});

  res.json({ ok: true, id: result.id, message: 'Signed up successfully. Am Yisrael Chai! 🕊️' });
});

// POST /api/push-token — register an FCM token for a subscriber
app.post('/api/push-token', (req, res) => {
  const { subscriberId, token } = req.body;
  if (!subscriberId || !token)
    return res.status(400).json({ ok: false, error: 'subscriberId and token required' });
  const ok = db.addPushToken(subscriberId, token);
  if (!ok) return res.status(404).json({ ok: false, error: 'Subscriber not found' });
  res.json({ ok: true });
});

// GET /unsubscribe/:id  (one-click from email/WhatsApp — redirects to the unsubscribe page)
app.get('/unsubscribe/:id', (req, res) => {
  res.redirect(`/unsubscribe?id=${encodeURIComponent(req.params.id)}`);
});

// GET /unsubscribe — dedicated unsubscribe page (handles ?id, ?email, ?phone)
app.get('/unsubscribe', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'unsubscribe.html'));
});

// POST /api/unsubscribe — unsubscribe by id, email, or phone number
app.post('/api/unsubscribe', (req, res) => {
  const { id, email, phone } = req.body;
  let removed = false;
  if (id)         removed = db.remove(id);
  else if (email) removed = db.removeByEmail(email);
  else if (phone) removed = db.removeByPhone(phone);
  else return res.status(400).json({ ok: false, error: 'id, email, or phone required' });
  res.json({ ok: removed });
});

// DELETE /api/push-token — revoke an FCM token (browser-initiated unsubscribe)
app.delete('/api/push-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, error: 'token required' });
  db.removePushTokens([token]);
  console.log('[Push] Token revoked by user');
  res.json({ ok: true });
});

// POST /api/whatsapp-webhook — Twilio inbound WhatsApp messages
app.post('/api/whatsapp-webhook', async (req, res) => {
  const body = (req.body.Body || '').trim().toLowerCase();
  const from = (req.body.From || '').replace('whatsapp:', ''); // E.164 number

  if (!from) return res.type('text/xml').send('<Response></Response>');

  // Handle opt-out
  if (['stop', 'unsubscribe', 'cancel', 'end', 'quit'].includes(body)) {
    const removed = db.removeByPhone(from);
    console.log(`[WhatsApp] STOP from ${from} — ${removed ? 'unsubscribed' : 'not found'}`);
    return res.type('text/xml').send('<Response></Response>');
  }

  // Handle join
  if (body === 'join tehillim') {
    const existing = db.getActive().find(s => s.whatsapp === from || s.phone === from);
    if (existing) {
      console.log(`[WhatsApp] Already subscribed: ${from}`);
      return res.type('text/xml').send('<Response></Response>');
    }

    const result = db.add({
      name:     from, // will be updated below to a friendly display
      method:   'whatsapp',
      whatsapp: from,
      source:   'whatsapp_direct',
    });

    if (result.ok) {
      console.log(`[WhatsApp] New subscriber via direct join: ${from}`);
      // Send welcome reply
      if (twilioClient) {
        const waFrom = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+18148940446';
        twilioClient.messages.create({
          body: `🕊️ *Tehillim for Tilim — You're in!*\n\nYou'll receive an alert here whenever rockets are detected in Israel.\n\n*עם ישראל חי — Am Yisrael Chai*\n\nTo unsubscribe anytime, reply STOP.`,
          from: waFrom,
          to:   `whatsapp:${from}`,
        }).catch(e => console.warn('[WhatsApp] Welcome reply failed:', e.message));
      }
    }
  }

  res.type('text/xml').send('<Response></Response>');
});

// POST /api/sms-webhook — Twilio inbound SMS (handles STOP / UNSUBSCRIBE replies)
app.post('/api/sms-webhook', (req, res) => {
  const body = (req.body.Body || '').trim().toUpperCase();
  const from = req.body.From || '';
  if (['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(body)) {
    const removed = db.removeByPhone(from);
    console.log(`[SMS] STOP from ${from} — ${removed ? 'unsubscribed' : 'not found'}`);
  }
  res.type('text/xml').send('<Response></Response>'); // TwiML empty response
});

// POST /api/admin/subscriber/:id/update — update subscriber fields (admin only)
app.post('/api/admin/subscriber/:id/update', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey) {
    const provided = req.query.key || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (provided !== adminKey) return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const { whatsapp, email, phone, name } = req.body;
  const subs = db.all();
  const idx  = subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  if (name     !== undefined) subs[idx].name     = name.trim();
  if (email    !== undefined) subs[idx].email    = email ? email.trim().toLowerCase() : null;
  if (whatsapp !== undefined) subs[idx].whatsapp = whatsapp ? db.normalizePhone(whatsapp) : null;
  if (phone    !== undefined) subs[idx].phone    = phone    ? db.normalizePhone(phone)    : null;
  db._write(subs);
  console.log(`[Admin] Updated subscriber ${subs[idx].name}:`, { whatsapp: subs[idx].whatsapp, email: subs[idx].email, phone: subs[idx].phone });
  res.json({ ok: true, subscriber: subs[idx] });
});

// PATCH /api/admin/subscriber/:id — update subscriber fields (admin only)
app.patch('/api/admin/subscriber/:id', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey) {
    const provided = req.query.key || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (provided !== adminKey) return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const { whatsapp, email, phone, name } = req.body;
  const subs = db.all();
  const idx  = subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  if (whatsapp !== undefined) subs[idx].whatsapp = whatsapp;
  if (email    !== undefined) subs[idx].email    = email;
  if (phone    !== undefined) subs[idx].phone    = phone;
  if (name     !== undefined) subs[idx].name     = name;
  db._write(subs);
  console.log(`[Admin] Updated subscriber ${subs[idx].name}:`, { whatsapp, email, phone, name });
  res.json({ ok: true, subscriber: subs[idx] });
});

// GET /admin — admin dashboard UI
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// GET /privacy and /terms
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// GET /api/admin
app.get('/api/admin', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey) {
    const provided = req.query.key || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (provided !== adminKey) return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const subs = db.all();
  res.json({
    totalSubscribers:  subs.length,
    activeSubscribers: subs.filter(s => s.active).length,
    recentAlerts:      alertLog.slice(0, 10),
    subscribers: subs.map(s => ({ id: s.id, name: s.name, method: s.method, source: s.source, email: s.email, phone: s.phone, whatsapp: s.whatsapp, active: s.active, createdAt: s.createdAt, notifiedAt: s.notifiedAt })),
  });
});

// POST /api/test-alert  (dev / admin only)
app.post('/api/test-alert', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!IS_DEV) {
    const provided = req.headers['x-admin-key'];
    if (!adminKey || !provided || provided !== adminKey)
      return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const areas = req.body.areas || ['Tel Aviv', 'Rishon LeZion', 'Bat Yam'];
  const payload = {
    id:     'test_' + Date.now(),
    areas,
    title:  'ירי רקטות וטילים',
    desc:   'TEST ALERT — היכנסו למרחב המוגן',
    source: 'manual',
    ts:     new Date().toISOString(),
  };

  logAlert('test_alert', payload);
  broadcast('alert', payload);
  const stats = await dispatch(payload);

  res.json({ ok: true, payload, notifyStats: stats });
});

// ── Catch-all: serve frontend ─────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Config check ──────────────────────────────────────────
function checkConfig() {
  const missing = [];

  if (!process.env.EMAILJS_PUBLIC_KEY)            missing.push('EMAILJS_PUBLIC_KEY — email notifications disabled');
  if (!process.env.EMAILJS_PRIVATE_KEY)           missing.push('EMAILJS_PRIVATE_KEY — email notifications disabled');
  if (!process.env.EMAILJS_SERVICE_ID)            missing.push('EMAILJS_SERVICE_ID — email notifications disabled');
  if (!process.env.EMAILJS_TEMPLATE_ID)           missing.push('EMAILJS_TEMPLATE_ID — email notifications disabled');
  if (!process.env.EMAILJS_WELCOME_TEMPLATE_ID)   missing.push('EMAILJS_WELCOME_TEMPLATE_ID — welcome emails will use alert template as fallback');

  const twilioConfigured = process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.startsWith('ACx');
  if (!twilioConfigured)                          missing.push('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN — SMS + WhatsApp disabled');
  if (twilioConfigured && !process.env.TWILIO_FROM_NUMBER)    missing.push('TWILIO_FROM_NUMBER — SMS disabled');
  if (twilioConfigured && !process.env.TWILIO_WHATSAPP_FROM)  missing.push('TWILIO_WHATSAPP_FROM — WhatsApp disabled');

  const firebaseConfigured = process.env.FIREBASE_PROJECT_ID &&
                             process.env.FIREBASE_PRIVATE_KEY &&
                             process.env.FIREBASE_CLIENT_EMAIL;
  if (!firebaseConfigured)                        missing.push('FIREBASE_PROJECT_ID / FIREBASE_PRIVATE_KEY / FIREBASE_CLIENT_EMAIL — push notifications disabled');
  if (firebaseConfigured && !process.env.FIREBASE_VAPID_KEY)  missing.push('FIREBASE_VAPID_KEY — browser push subscription will fail');

  if (!process.env.BASE_URL)                      missing.push('BASE_URL — unsubscribe links will fall back to http://localhost:3000');
  if (!process.env.ADMIN_KEY)                     missing.push('ADMIN_KEY — /api/admin is unprotected');

  if (missing.length) {
    console.warn('\n⚠️  Missing configuration — some features are disabled:');
    missing.forEach(m => console.warn(`   • ${m}`));
    console.warn('   See .env.example for setup instructions.\n');
  } else {
    console.log('✅ All services configured.\n');
  }
}

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Tehillim for Tilim server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket at ws://localhost:${PORT}/ws`);
  console.log(`👥 Subscribers: ${db.count()}`);
  console.log(`🔔 Alert polling: every ${process.env.POLL_INTERVAL_SECONDS || 5}s`);
  checkConfig();
  poller.start();
});

// ── Helpers ───────────────────────────────────────────────
function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Graceful shutdown
process.on('SIGTERM', () => { poller.stop(); server.close(); });
process.on('SIGINT',  () => { poller.stop(); server.close(); process.exit(0); });

module.exports = { app, server };
