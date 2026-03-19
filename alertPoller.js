/**
 * alertPoller.js
 * Polls the Pikud Ha'oref (Israel Home Front Command) API every N seconds.
 * Emits 'alert' events when new rocket fire is detected.
 * Emits 'clear' events when the alert window ends.
 *
 * Primary source:  https://www.oref.org.il  (official IDF Home Front Command)
 * Fallback source: https://api.tzevaadom.co.il (community mirror, higher uptime)
 */

const { EventEmitter } = require('events');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const OREF_URL      = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const TZEVA_URL     = 'https://api.tzevaadom.co.il/alerts';
const POLL_MS       = (parseInt(process.env.POLL_INTERVAL_SECONDS) || 5) * 1000;
const CLEAR_AFTER_MS = 30_000; // consider alert over if no new data for 30s

class AlertPoller extends EventEmitter {
  constructor() {
    super();
    this._lastAlertId    = null;
    this._lastAlertTime  = null;
    this._clearTimer     = null;
    this._active         = false;
    this._timer          = null;
    this._useFallback    = false;
    this._consecutiveFails = 0;
  }

  start() {
    console.log(`[Poller] Starting — polling every ${POLL_MS / 1000}s`);
    this._tick();
    this._timer = setInterval(() => this._tick(), POLL_MS);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._clearTimer) clearTimeout(this._clearTimer);
  }

  async _tick() {
    try {
      const data = this._useFallback
        ? await this._fetchTzevaadom()
        : await this._fetchOref();

      this._consecutiveFails = 0;
      this._useFallback = false;
      this._handleData(data);
    } catch (err) {
      this._consecutiveFails++;
      console.warn(`[Poller] Fetch failed (${this._consecutiveFails}):`, err.message);

      // Switch to fallback after 3 consecutive primary failures
      if (this._consecutiveFails >= 3 && !this._useFallback) {
        console.log('[Poller] Switching to fallback source: tzevaadom.co.il');
        this._useFallback = true;
      }
    }
  }

  // ── Primary: oref.org.il ────────────────────────────────
  async _fetchOref() {
    const res = await fetch(OREF_URL, {
      headers: {
        'Referer':          'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept':           'application/json',
        'User-Agent':       'Mozilla/5.0 (compatible; TehillimForTilim/1.0)',
      },
      timeout: 4000,
    });

    // 204 = no active alert
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`oref HTTP ${res.status}`);

    const text = await res.text();
    if (!text || text.trim() === '') return null;

    // Strip BOM if present
    const clean = text.replace(/^\uFEFF/, '').trim();
    return JSON.parse(clean);
    // Shape: { id: "133...", cat: "1", title: "ירי רקטות...", data: ["תל אביב", ...], desc: "..." }
  }

  // ── Fallback: tzevaadom.co.il ───────────────────────────
  async _fetchTzevaadom() {
    const res = await fetch(TZEVA_URL, {
      headers: { 'Accept': 'application/json' },
      timeout: 4000,
    });
    if (!res.ok) throw new Error(`tzevaadom HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.alerts || data.alerts.length === 0) return null;

    // Normalize to oref shape
    const latest = data.alerts[0];
    return {
      id:    String(latest.time || Date.now()),
      cat:   '1',
      title: latest.title || 'ירי רקטות וטילים',
      data:  latest.cities || [],
      desc:  latest.instructions || 'היכנסו למרחב המוגן',
    };
  }

  // ── Handle parsed alert data ────────────────────────────
  _handleData(raw) {
    if (!raw || !raw.data || raw.data.length === 0) {
      // No active alert in response — start clear countdown
      if (this._active && !this._clearTimer) {
        this._clearTimer = setTimeout(() => this._emitClear(), CLEAR_AFTER_MS);
      }
      return;
    }

    // Cancel any pending clear
    if (this._clearTimer) {
      clearTimeout(this._clearTimer);
      this._clearTimer = null;
    }

    const alertId = raw.id || String(raw.data.join(','));

    if (alertId !== this._lastAlertId) {
      this._lastAlertId   = alertId;
      this._lastAlertTime = Date.now();
      this._active        = true;

      const payload = {
        id:     alertId,
        areas:  raw.data,           // Hebrew area names
        title:  raw.title,
        desc:   raw.desc,
        source: this._useFallback ? 'tzevaadom' : 'oref',
        ts:     new Date().toISOString(),
      };

      console.log(`[Poller] 🚨 ALERT — ${payload.areas.join(', ')}`);
      this.emit('alert', payload);
    }
  }

  _emitClear() {
    if (!this._active) return;
    this._active       = false;
    this._clearTimer   = null;
    this._lastAlertId  = null;
    console.log('[Poller] ✅ Alert cleared');
    this.emit('clear');
  }

  getStatus() {
    return {
      active:   this._active,
      source:   this._useFallback ? 'tzevaadom' : 'oref',
      lastId:   this._lastAlertId,
      lastTime: this._lastAlertTime,
    };
  }
}

module.exports = new AlertPoller();
