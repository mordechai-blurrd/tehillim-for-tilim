/**
 * server.js
 * Tehillim for Tilim — Backend Server
 *
 * Routes:
 *   GET  /api/status          — Current alert status + subscriber count
 *   POST /api/subscribe       — Sign up for notifications
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

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

const PORT   = process.env.PORT || 3000;
const IS_DEV = process.env.NODE_ENV !== 'production';

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
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
  // Send current status immediately on connect
  ws.send(JSON.stringify({
    event: 'status',
    data:  { ...poller.getStatus(), subscribers: db.count() },
    ts:    new Date().toISOString(),
  }));
  ws.on('close', () => console.log(`[WS] Client disconnected (total: ${wss.clients.size})`));
});

// ── Poller event handlers ─────────────────────────────────
poller.on('alert', async (payload) => {
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

// POST /api/subscribe
app.post('/api/subscribe', async (req, res) => {
  const { name, method, email, phone, whatsapp } = req.body;

  const VALID_METHODS = ['email','sms','whatsapp','sms_whatsapp','email_sms','email_whatsapp','all'];
  const needsEmail = m => ['email','email_sms','email_whatsapp','all'].includes(m);
  const needsPhone = m => ['sms','sms_whatsapp','email_sms','all'].includes(m);
  const needsWA    = m => ['whatsapp','sms_whatsapp','email_whatsapp','all'].includes(m);

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

  // Fire welcome email async (don't block response)
  const sub = db.all().find(s => s.id === result.id);
  if (sub) sendWelcome(sub).catch(() => {});

  res.json({ ok: true, id: result.id, message: 'Signed up successfully. Am Yisrael Chai! 🕊️' });
});

// GET /unsubscribe/:id  (one-click from email/SMS)
app.get('/unsubscribe/:id', (req, res) => {
  const removed = db.remove(req.params.id);
  res.send(`
    <!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Unsubscribed — Tehillim for Tilim</title>
    <style>
      body { font-family: Georgia, serif; background: #0b1120; color: #f5f0e8;
             display: flex; align-items: center; justify-content: center;
             min-height: 100vh; margin: 0; text-align: center; padding: 24px; }
      h1 { color: #c9a84c; font-size: 28px; margin-bottom: 12px; }
      p  { color: #8b96a8; font-size: 16px; line-height: 1.6; }
      a  { color: #c9a84c; }
    </style>
    </head><body>
    <div>
      <div style="font-size:48px;margin-bottom:16px">🕊️</div>
      <h1>${removed ? 'You\'ve been unsubscribed' : 'Link already used'}</h1>
      <p>${removed
        ? 'You will no longer receive Tehillim for Tilim alerts.<br>We hope you\'ll rejoin us soon.'
        : 'This unsubscribe link has already been used or is invalid.'
      }</p>
      <p style="margin-top:24px"><a href="/">Return to Tehillim for Tilim →</a></p>
    </div>
    </body></html>
  `);
});

// GET /api/admin
app.get('/api/admin', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey) {
    const provided = req.query.key || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (provided !== adminKey) return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const subs = db.all();
  res.json({
    totalSubscribers: subs.length,
    activeSubscribers: subs.filter(s => s.active).length,
    recentAlerts: alertLog.slice(0, 10),
    subscribers: IS_DEV ? subs : subs.map(s => ({ id: s.id, name: s.name, method: s.method, createdAt: s.createdAt, active: s.active })),
  });
});

// POST /api/test-alert  (dev only)
app.post('/api/test-alert', async (req, res) => {
  if (!IS_DEV && !req.headers['x-admin-key']) {
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

  if (!process.env.EMAILJS_PUBLIC_KEY)           missing.push('EMAILJS_PUBLIC_KEY — email notifications disabled');
  if (!process.env.EMAILJS_PRIVATE_KEY)          missing.push('EMAILJS_PRIVATE_KEY — email notifications disabled');
  if (!process.env.EMAILJS_SERVICE_ID)           missing.push('EMAILJS_SERVICE_ID — email notifications disabled');
  if (!process.env.EMAILJS_TEMPLATE_ID)          missing.push('EMAILJS_TEMPLATE_ID — email notifications disabled');
  if (!process.env.EMAILJS_WELCOME_TEMPLATE_ID)  missing.push('EMAILJS_WELCOME_TEMPLATE_ID — welcome emails will use alert template as fallback');

  const twilioConfigured = process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.startsWith('ACx');
  if (!twilioConfigured)                         missing.push('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN — SMS + WhatsApp disabled');
  if (twilioConfigured && !process.env.TWILIO_FROM_NUMBER)   missing.push('TWILIO_FROM_NUMBER — SMS disabled');
  if (twilioConfigured && !process.env.TWILIO_WHATSAPP_FROM) missing.push('TWILIO_WHATSAPP_FROM — WhatsApp disabled');

  if (!process.env.BASE_URL)                     missing.push('BASE_URL — unsubscribe links will fall back to http://localhost:3000');
  if (!process.env.ADMIN_KEY)                    missing.push('ADMIN_KEY — /api/admin is unprotected');

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
