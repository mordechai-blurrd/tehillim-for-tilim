/**
 * notifier.js
 * Sends alert notifications via:
 *   - Email    → EmailJS (free: 200/month)
 *   - SMS      → Twilio  (works in 180+ countries)
 *   - WhatsApp → Twilio WhatsApp API (same Twilio account, different sender prefix)
 *
 * WhatsApp setup notes:
 *   Sandbox (free testing): Use twilio.com/console/sms/whatsapp/sandbox
 *     TWILIO_WHATSAPP_FROM=whatsapp:+14155238886  (Twilio sandbox number)
 *     Users must send "join <your-word>" to that number once to opt in.
 *   Production: Apply for a WhatsApp Business number in Twilio console.
 *     TWILIO_WHATSAPP_FROM=whatsapp:+1XXXXXXXXXX  (your approved number)
 */

require('dotenv').config();
const db = require('./db');

// ── EmailJS ────────────────────────────────────────────────
let emailjs;
try {
  emailjs = require('@emailjs/nodejs');
  if (process.env.EMAILJS_PUBLIC_KEY) {
    emailjs.init({ publicKey: process.env.EMAILJS_PUBLIC_KEY, privateKey: process.env.EMAILJS_PRIVATE_KEY });
    console.log('[Notifier] EmailJS initialized ✓');
  } else {
    console.warn('[Notifier] EmailJS not configured — set EMAILJS_* env vars');
    emailjs = null;
  }
} catch (e) { console.warn('[Notifier] EmailJS unavailable:', e.message); emailjs = null; }

// ── Twilio (SMS + WhatsApp) ────────────────────────────────
let twilioClient;
try {
  if (process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.startsWith('ACx')) {
    twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('[Notifier] Twilio initialized ✓ (SMS + WhatsApp)');
  } else {
    console.warn('[Notifier] Twilio not configured — set TWILIO_* env vars');
  }
} catch (e) { console.warn('[Notifier] Twilio unavailable:', e.message); }

const BASE_URL    = process.env.BASE_URL || 'http://localhost:3000';
const COOLDOWN_MS = (parseInt(process.env.ALERT_COOLDOWN_SECONDS) || 120) * 1000;

// ── Helpers ─────────────────────────────────────────────────
const wantsEmail    = m => ['email','email_sms','email_whatsapp','all'].includes(m);
const wantsSMS      = m => ['sms','sms_whatsapp','email_sms','all'].includes(m);
const wantsWhatsApp = m => ['whatsapp','sms_whatsapp','email_whatsapp','all'].includes(m);

// Cooldown: per subscriber
const recentlySent = new Map();

// ── Main dispatch ──────────────────────────────────────────
async function dispatch(alertPayload) {
  const subscribers = db.getActive();
  if (!subscribers.length) { console.log('[Notifier] No subscribers.'); return { sent: 0, skipped: 0, errors: 0 }; }

  const areas   = alertPayload.areas || [];
  const areaStr = areas.length
    ? areas.slice(0, 5).join(', ') + (areas.length > 5 ? ` +${areas.length - 5} more` : '')
    : 'Israel';
  const timeStr = new Date(alertPayload.ts).toLocaleTimeString('en-US',
    { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });

  const stats    = { sent: 0, skipped: 0, errors: 0 };
  const promises = [];

  for (const sub of subscribers) {
    const lastSent = recentlySent.get(sub.id);
    if (lastSent && Date.now() - lastSent < COOLDOWN_MS) { stats.skipped++; continue; }

    const mark = () => { stats.sent++; recentlySent.set(sub.id, Date.now()); db.markNotified(sub.id); };
    const fail = (channel, err) => { stats.errors++; console.error(`[Notifier] ${channel} failed for ${sub.name}:`, err.message); };

    if (wantsEmail(sub.method) && sub.email)
      promises.push(sendEmail(sub, areaStr, timeStr).then(mark).catch(e => fail('Email', e)));

    if (wantsSMS(sub.method) && sub.phone)
      promises.push(sendSMS(sub, areaStr, timeStr).then(mark).catch(e => fail('SMS', e)));

    if (wantsWhatsApp(sub.method) && sub.whatsapp)
      promises.push(sendWhatsApp(sub, areaStr, timeStr).then(mark).catch(e => fail('WhatsApp', e)));
  }

  await Promise.allSettled(promises);
  console.log(`[Notifier] Done — sent:${stats.sent} skipped:${stats.skipped} errors:${stats.errors}`);
  return stats;
}

// ── Email ──────────────────────────────────────────────────
async function sendEmail(sub, areaStr, timeStr) {
  if (!emailjs) { console.log(`[DRY RUN] Email → ${sub.email}`); return; }
  return emailjs.send(
    process.env.EMAILJS_SERVICE_ID,
    process.env.EMAILJS_TEMPLATE_ID,
    {
      to_name:         sub.name,
      to_email:        sub.email,
      areas:           areaStr,
      alert_time:      `${timeStr} (Israel time)`,
      message:         buildEmailBody(sub.name, areaStr, timeStr),
      unsubscribe_url: `${BASE_URL}/unsubscribe/${sub.id}`,
    }
  );
}

// ── SMS ────────────────────────────────────────────────────
async function sendSMS(sub, areaStr, timeStr) {
  const body = `🚨 ROCKET ALERT — ${areaStr} (${timeStr} IL). Stop & say Tehillim now. עם ישראל חי | Unsubscribe: ${BASE_URL}/unsubscribe/${sub.id}`;
  if (!twilioClient) { console.log(`[DRY RUN] SMS → ${sub.phone}: ${body}`); return; }
  return twilioClient.messages.create({ body, from: process.env.TWILIO_FROM_NUMBER, to: sub.phone });
}

// ── WhatsApp ───────────────────────────────────────────────
async function sendWhatsApp(sub, areaStr, timeStr) {
  const body = buildWhatsAppBody(sub.name, areaStr, timeStr, sub.id);
  const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // Sandbox default

  if (!twilioClient) { console.log(`[DRY RUN] WhatsApp → ${sub.whatsapp}`); return; }

  return twilioClient.messages.create({
    body,
    from,
    to: `whatsapp:${sub.whatsapp}`,  // Twilio requires the whatsapp: prefix
  });
}

// ── Message builders ───────────────────────────────────────
function buildEmailBody(name, areas, time) {
  return `Shalom ${name},

🚨 RED ALERT — Rocket fire detected near: ${areas}
Time: ${time} (Israel time)

Please stop what you are doing and say Tehillim now.
Even one Psalm said with full intention rises straight to Heaven.

עם ישראל חי — Am Yisrael Chai.

Suggested: Tehillim 20, 83, 121, or 130.

—
Tehillim for Tilim | תהילים לטילים`;
}

function buildWhatsAppBody(name, areas, time, subId) {
  // WhatsApp supports more characters than SMS — use a richer message
  return `🚨 *RED ALERT — Tehillim for Tilim*

Shalom ${name},

Rocket fire has been detected near:
📍 *${areas}*
🕐 ${time} (Israel time)

*Please stop and say Tehillim now.*
Even one Psalm said with intention is powerful.

Suggested: Chapters 20, 83, 121, or 130.

_עם ישראל חי — Am Yisrael Chai_ 🕊️

Unsubscribe: ${BASE_URL}/unsubscribe/${subId}`;
}

// ── Welcome messages ───────────────────────────────────────
async function sendWelcome(sub) {
  const promises = [];

  if (sub.email && emailjs) {
    promises.push(
      emailjs.send(
        process.env.EMAILJS_SERVICE_ID,
        process.env.EMAILJS_WELCOME_TEMPLATE_ID || process.env.EMAILJS_TEMPLATE_ID,
        {
          to_name:         sub.name,
          to_email:        sub.email,
          message:         `Welcome! You'll be notified whenever rockets are detected in Israel. עם ישראל חי`,
          unsubscribe_url: `${BASE_URL}/unsubscribe/${sub.id}`,
          areas:           '',
          alert_time:      '',
        }
      ).catch(e => console.warn('[Notifier] Welcome email failed:', e.message))
    );
  }

  if (sub.whatsapp && twilioClient) {
    const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
    promises.push(
      twilioClient.messages.create({
        body: `🕊️ *Tehillim for Tilim — Welcome, ${sub.name}!*\n\nYou're signed up. You'll receive an alert here whenever rockets are detected in Israel.\n\n*עם ישראל חי — Am Yisrael Chai*\n\nUnsubscribe anytime: ${BASE_URL}/unsubscribe/${sub.id}`,
        from,
        to: `whatsapp:${sub.whatsapp}`,
      }).catch(e => console.warn('[Notifier] Welcome WhatsApp failed:', e.message))
    );
  }

  await Promise.allSettled(promises);
}

module.exports = { dispatch, sendWelcome };
