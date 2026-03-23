/**
 * alertPoller.js
 * Polls the Pikud Ha'oref (Israel Home Front Command) API every N seconds.
 * Emits 'alert' events when new rocket fire is detected.
 * Emits 'clear' events when the alert window ends.
 *
 * Source chain (falls through on consecutive failures):
 *   1. oref.org.il        — official IDF feed (requires Israeli IP)
 *   2. tzevaadom.co.il    — community mirror, globally accessible
 *   3. mako.co.il         — Israeli news feed, globally accessible
 */

const { EventEmitter } = require('events');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const OREF_URL  = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const TZEVA_URL = 'https://api.tzevaadom.co.il/notifications';
const MAKO_URL  = 'https://www.mako.co.il/Collab/amudanan/alerts.json';

const POLL_MS        = (parseInt(process.env.POLL_INTERVAL_SECONDS) || 5) * 1000;

// Returns false for known non-rocket alert types so they are dropped.
// Uses a blacklist (not whitelist) so unknown/empty titles are allowed through
// rather than silently swallowing real rocket alerts.
function isRocketTitle(title) {
  if (!title) return true; // no title — assume rocket, don't suppress
  return !/כלי טיס|חדירת|עימות|פירוט התרעה|רעידת אדמה|רדיולוגי|חומרים מסוכנים|צונאמי|פיגוע/.test(title);
}
const CLEAR_AFTER_MS = 30_000;
const SOURCES        = ['oref', 'tzevaadom', 'mako'];
const WATCHDOG_MS    = 3 * 60 * 1000;  // check every 3 min
const STALE_MS       = 5 * 60 * 1000;  // restart if no success in 5 min

class AlertPoller extends EventEmitter {
  constructor() {
    super();
    this._lastAlertId      = null;
    this._lastAreaKey      = null;  // sorted area fingerprint for dedup
    this._lastAlertTime    = null;
    this._clearTimer       = null;
    this._active           = false;
    this._timer            = null;
    this._watchdogTimer    = null;
    this._sourceIdx        = 0;   // index into SOURCES
    this._consecutiveFails = 0;
    this._lastSuccessTime  = null;
  }

  start() {
    console.log(`[Poller] Starting — polling every ${POLL_MS / 1000}s`);
    this._lastSuccessTime = Date.now(); // grace period on startup
    this._tick();
    this._timer = setInterval(() => this._tick(), POLL_MS);
    this._watchdogTimer = setInterval(() => this._watchdog(), WATCHDOG_MS);
  }

  stop() {
    if (this._timer)        clearInterval(this._timer);
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    if (this._clearTimer)   clearTimeout(this._clearTimer);
  }

  _watchdog() {
    const stale = Date.now() - (this._lastSuccessTime || 0) > STALE_MS;
    if (!stale) return;
    console.error(`[Watchdog] ⚠️  No successful poll in ${STALE_MS / 60000} min — restarting poller`);
    clearInterval(this._timer);
    this._sourceIdx        = 1; // restart on tzevaadom (skip oref — needs Israeli IP)
    this._consecutiveFails = 0;
    this._lastSuccessTime  = Date.now();
    this._tick();
    this._timer = setInterval(() => this._tick(), POLL_MS);
    console.log('[Watchdog] Poller restarted.');
  }

  async _tick() {
    try {
      const data = await this._fetchCurrent();
      this._consecutiveFails = 0;
      this._lastSuccessTime  = Date.now();
      this._handleData(data);
    } catch (err) {
      this._consecutiveFails++;
      console.warn(`[Poller] Fetch failed (${this._consecutiveFails}) [${SOURCES[this._sourceIdx]}]:`, err.message);

      // Cycle to next source after 3 consecutive failures (wraps back to tzevaadom, skipping oref)
      if (this._consecutiveFails >= 3) {
        const next = this._sourceIdx < SOURCES.length - 1 ? this._sourceIdx + 1 : 1; // skip oref on wrap
        this._sourceIdx = next;
        this._consecutiveFails = 0;
        console.log(`[Poller] Switching source: ${SOURCES[this._sourceIdx]}`);
      }
    }
  }

  _fetchCurrent() {
    switch (SOURCES[this._sourceIdx]) {
      case 'tzevaadom': return this._fetchTzevaadom();
      case 'mako':      return this._fetchMako();
      default:          return this._fetchOref();
    }
  }

  // ── Primary: oref.org.il (requires Israeli IP) ──────────
  async _fetchOref() {
    const res = await fetch(OREF_URL, {
      headers: {
        'Referer':          'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept':           'application/json',
        'User-Agent':       'Mozilla/5.0 (compatible; TehillimForTilim/1.0)',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`oref HTTP ${res.status}`);

    const text = await res.text();
    if (!text || text.trim() === '') return null;

    const clean = text.replace(/^\uFEFF/, '').trim();
    return JSON.parse(clean);
    // Shape: { id, cat, title, data: ["תל אביב", ...], desc }
  }

  // ── Fallback 1: api.tzevaadom.co.il/notifications ───────
  async _fetchTzevaadom() {
    const res = await fetch(TZEVA_URL, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`tzevaadom HTTP ${res.status}`);
    const data = await res.json();

    // Returns [] when quiet, array of notification objects when active
    if (!Array.isArray(data) || data.length === 0) return null;

    const latest = data[0];
    const title  = latest.title || '';

    // Filter: only rocket/missile alerts. Skip hostile aircraft, earthquakes, etc.
    if (!isRocketTitle(title)) {
      console.log(`[Poller] Skipping non-rocket tzevaadom alert: "${title}"`);
      return null;
    }

    return {
      id:    String(latest.time || latest.id || Date.now()),
      cat:   '1',
      title: title || 'ירי רקטות וטילים',
      data:  latest.cities || latest.data || [],
      desc:  latest.instructions || latest.desc || 'היכנסו למרחב המוגן',
    };
  }

  // ── Fallback 2: mako.co.il alerts feed ──────────────────
  async _fetchMako() {
    const res = await fetch(MAKO_URL, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`mako HTTP ${res.status}`);
    const data = await res.json();

    // Shape: { id: "timestamp", title: "...", data: ["city", ...] }
    if (!data || !Array.isArray(data.data) || data.data.length === 0) return null;

    const title = data.title || '';
    if (!isRocketTitle(title)) {
      console.log(`[Poller] Skipping non-rocket mako alert: "${title}"`);
      return null;
    }

    return {
      id:    String(data.id || Date.now()),
      cat:   '1',
      title: title || 'ירי רקטות וטילים',
      data:  data.data,
      desc:  'היכנסו למרחב המוגן',
    };
  }

  // ── Handle parsed alert data ────────────────────────────
  _handleData(raw) {
    // Only process rocket/missile alerts (cat 1). Filter out hostile aircraft,
    // earthquakes, radiological, terror, hazmat, tsunami, etc.
    if (raw && raw.cat != null && String(raw.cat) !== '1') {
      console.log(`[Poller] Skipping non-rocket alert (cat=${raw.cat}): ${raw.title || ''}`);
      return;
    }
    if (raw && !isRocketTitle(raw.title || '')) {
      console.log(`[Poller] Skipping non-rocket alert (title): ${raw.title || ''}`);
      return;
    }

    if (!raw || !raw.data || raw.data.length === 0) {
      if (this._active && !this._clearTimer) {
        this._clearTimer = setTimeout(() => this._emitClear(), CLEAR_AFTER_MS);
      }
      return;
    }

    if (this._clearTimer) {
      clearTimeout(this._clearTimer);
      this._clearTimer = null;
    }

    const alertId = raw.id || String(raw.data.join(','));
    const ageMs   = this._lastAlertTime ? Date.now() - this._lastAlertTime : Infinity;

    // Suppress if we already emitted an alert within the cooldown window.
    // Using time-only (not area fingerprint) because an ongoing alert expands
    // to more cities between polls — the area set changes but it's the same event.
    const EMIT_COOLDOWN_MS = (parseInt(process.env.ALERT_COOLDOWN_SECONDS) || 120) * 1000;
    const isDuplicate = alertId === this._lastAlertId || ageMs < EMIT_COOLDOWN_MS;

    if (!isDuplicate) {
      this._lastAlertId   = alertId;
      this._lastAreaKey   = null;  // no longer used for dedup
      this._lastAlertTime = Date.now();
      this._active        = true;

      const payload = {
        id:     alertId,
        areas:  raw.data,
        title:  raw.title,
        desc:   raw.desc,
        source: SOURCES[this._sourceIdx],
        ts:     new Date().toISOString(),
      };

      console.log(`[Poller] 🚨 ALERT (${payload.source}) — ${payload.areas.join(', ')}`);
      this.emit('alert', payload);
    }
  }

  _emitClear() {
    if (!this._active) return;
    this._active       = false;
    this._clearTimer   = null;
    this._lastAlertId  = null;
    this._lastAreaKey  = null;
    console.log('[Poller] ✅ Alert cleared');
    this.emit('clear');
  }

  getStatus() {
    const pollerHealthy = this._lastSuccessTime
      ? (Date.now() - this._lastSuccessTime) < STALE_MS
      : false;
    return {
      active:         this._active,
      source:         SOURCES[this._sourceIdx],
      lastId:         this._lastAlertId,
      lastTime:       this._lastAlertTime,
      pollerHealthy,
      lastSuccessTime: this._lastSuccessTime,
    };
  }
}

module.exports = new AlertPoller();
