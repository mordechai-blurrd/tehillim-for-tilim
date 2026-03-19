/**
 * db.js
 * Lightweight file-based subscriber store.
 * In production, swap _read/_write with a real DB (Postgres, MongoDB, etc.)
 *
 * Schema per subscriber:
 * {
 *   id:        string  (uuid)
 *   name:      string
 *   method:    'email' | 'sms' | 'whatsapp' | 'sms_whatsapp' | 'email_sms' | 'email_whatsapp' | 'all'
 *   email:     string | null
 *   phone:     string | null   (E.164 — used for SMS)
 *   whatsapp:  string | null   (E.164 — used for WhatsApp; often same as phone)
 *   active:    boolean
 *   createdAt: ISO string
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

const VALID_METHODS = ['email','sms','whatsapp','sms_whatsapp','email_sms','email_whatsapp','all'];

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

    // Deduplicate
    const dupe = subs.find(s =>
      (email    && s.email    === email?.trim().toLowerCase()) ||
      (phone    && s.phone    === normalizePhone(phone))       ||
      (whatsapp && s.whatsapp === normalizePhone(whatsapp))
    );
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
};

function needsWhatsapp(method) {
  return ['whatsapp','sms_whatsapp','email_whatsapp','all'].includes(method);
}

function normalizePhone(phone) {
  const digits = phone.replace(/[\s\-().]/g, '');
  return digits.startsWith('+') ? digits : '+' + digits;
}

module.exports = db;
