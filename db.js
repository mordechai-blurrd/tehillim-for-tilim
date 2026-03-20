/**
 * db.js
 * Lightweight file-based subscriber store.
 * In production, swap _read/_write with a real DB (Postgres, MongoDB, etc.)
 *
 * Schema per subscriber:
 * {
 *   id:         string  (uuid)
 *   name:       string
 *   method:     see VALID_METHODS below
 *   email:      string | null
 *   phone:      string | null   (E.164 — used for SMS)
 *   whatsapp:   string | null   (E.164 — used for WhatsApp; often same as phone)
 *   pushTokens: string[]        (FCM tokens, one per device)
 *   active:     boolean
 *   createdAt:  ISO string
 *   notifiedAt: ISO string | null
 * }
 */

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Use the persistent volume path in production (/app/data must be mounted as a
// Railway volume). Falls back to the project root for local development.
const DATA_DIR = fs.existsSync('/app/data') ? '/app/data' : __dirname;
const DB_PATH  = path.join(DATA_DIR, 'subscribers.json');
console.log(`[DB] Store: ${DB_PATH}`);

const VALID_METHODS = [
  'email', 'sms', 'whatsapp', 'push',
  'sms_whatsapp', 'email_sms', 'email_whatsapp', 'email_push',
  'whatsapp_push', 'email_whatsapp_push', 'all',
];

function _read() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch { return []; }
}

function _write(subs) {
  fs.writeFileSync(DB_PATH, JSON.stringify(subs, null, 2), 'utf-8');
}

const db = {
  add({ name, method, email, phone, whatsapp }) {
    if (!VALID_METHODS.includes(method)) return { ok: false, error: 'invalid_method' };

    const subs = _read();

    // Deduplicate — only block if the existing record is still active
    const dupe = subs.find(s => s.active && (
      (email    && s.email    === email?.trim().toLowerCase()) ||
      (phone    && s.phone    === normalizePhone(phone))       ||
      (whatsapp && s.whatsapp === normalizePhone(whatsapp))
    ));
    if (dupe) return { ok: false, error: 'already_exists', id: dupe.id };

    // Normalize: if whatsapp number not given separately, use phone
    const resolvedWA = whatsapp
      ? normalizePhone(whatsapp)
      : (phone && needsWhatsapp(method)) ? normalizePhone(phone) : null;

    const sub = {
      id:         randomUUID(),
      name:       name.trim(),
      method,
      email:      email    ? email.trim().toLowerCase() : null,
      phone:      phone    ? normalizePhone(phone)      : null,
      whatsapp:   resolvedWA,
      pushTokens: [],
      active:     true,
      createdAt:  new Date().toISOString(),
      notifiedAt: null,
    };

    subs.push(sub);
    _write(subs);
    console.log(`[DB] New subscriber: ${sub.name} via ${sub.method}`);
    return { ok: true, id: sub.id };
  },

  getActive() { return _read().filter(s => s.active); },
  count()     { return _read().filter(s => s.active).length; },

  markNotified(id) {
    const subs = _read();
    const idx  = subs.findIndex(s => s.id === id);
    if (idx !== -1) { subs[idx].notifiedAt = new Date().toISOString(); _write(subs); }
  },

  remove(id) {
    const subs = _read();
    const idx  = subs.findIndex(s => s.id === id);
    if (idx === -1) return false;
    subs[idx].active = false;
    _write(subs);
    return true;
  },

  all() { return _read(); },

  removeByEmail(email) {
    const normalized = email.trim().toLowerCase();
    const subs = _read();
    const idx  = subs.findIndex(s => s.active && s.email === normalized);
    if (idx === -1) return false;
    subs[idx].active = false;
    _write(subs);
    console.log(`[DB] Unsubscribed by email: ${normalized}`);
    return true;
  },

  removeByPhone(phone) {
    try {
      const normalized = normalizePhone(phone);
      const subs = _read();
      const idx  = subs.findIndex(s => s.active && (s.phone === normalized || s.whatsapp === normalized));
      if (idx === -1) return false;
      subs[idx].active = false;
      _write(subs);
      console.log(`[DB] Unsubscribed by phone: ${normalized}`);
      return true;
    } catch { return false; }
  },

  // ── Push token management ────────────────────────────────

  addPushToken(subscriberId, token) {
    const subs = _read();
    const idx  = subs.findIndex(s => s.id === subscriberId);
    if (idx === -1) return false;
    if (!subs[idx].pushTokens) subs[idx].pushTokens = [];
    if (!subs[idx].pushTokens.includes(token)) {
      subs[idx].pushTokens.push(token);
      _write(subs);
      console.log(`[DB] Push token saved for ${subs[idx].name}`);
    }
    return true;
  },

  getAllPushTokens() {
    const subs = _read().filter(s => s.active);
    const tokens = new Set();
    subs.forEach(s => {
      if (wantsPush(s.method) && Array.isArray(s.pushTokens)) {
        s.pushTokens.forEach(t => tokens.add(t));
      }
    });
    return [...tokens];
  },

  removePushTokens(expiredTokens) {
    const subs    = _read();
    let changed   = false;
    subs.forEach(s => {
      if (!Array.isArray(s.pushTokens)) return;
      const before = s.pushTokens.length;
      s.pushTokens = s.pushTokens.filter(t => !expiredTokens.includes(t));
      if (s.pushTokens.length !== before) changed = true;
    });
    if (changed) _write(subs);
  },
};

function needsWhatsapp(method) {
  return ['whatsapp','sms_whatsapp','email_whatsapp','all',
          'whatsapp_push','email_whatsapp_push'].includes(method);
}

function wantsPush(method) {
  return ['push','email_push','whatsapp_push','email_whatsapp_push'].includes(method);
}

function normalizePhone(phone) {
  const digits = phone.replace(/[\s\-().]/g, '');
  return digits.startsWith('+') ? digits : '+' + digits;
}

db._write = _write;
module.exports = db;
