'use strict';

// Per-feed fetch state: conditional-GET validators, failure backoff, and the
// health fields the Feeds page shows. Scheduling math is kept as small pure
// functions so it can be tested without a clock or a server.

const fs = require('fs');
const path = require('path');

const BASE_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** Upper bound on how long a feed's own Cache-Control/Expires may keep us from re-checking. */
const MAX_FRESH_MS = 60 * 60 * 1000;

/** interval * 1.8^failures, capped. `failures` counts the failure just recorded. */
function backoffDelay(failures, base = BASE_BACKOFF_MS, max = MAX_BACKOFF_MS) {
  if (!(failures > 0)) return 0;
  return Math.min(base * Math.pow(1.8, failures - 1), max);
}

/** Retry-After as seconds or an HTTP date, in ms from now (0 when absent/invalid). */
function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, MAX_BACKOFF_MS);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), MAX_BACKOFF_MS) : 0;
}

/** How long the response says it stays fresh (Cache-Control max-age, else Expires), capped. */
function parseFreshness(cacheControl, expires, now = Date.now()) {
  const cc = String(cacheControl || '').toLowerCase();
  if (/\b(no-store|no-cache)\b/.test(cc)) return 0;
  const m = cc.match(/\bmax-age=(\d+)/);
  if (m) return Math.min(Number(m[1]) * 1000, MAX_FRESH_MS);
  if (expires) {
    const at = Date.parse(expires);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - now), MAX_FRESH_MS);
  }
  return 0;
}

function createFeedStateStore(filePath) {
  let state = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
  } catch {}
  // Last good parsed payload per feed, memory only: lets a 304 or a backoff
  // window still answer with items. After a restart the first fetch is a full GET.
  const bodies = new Map();
  let timer = null;

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    } catch {}
  }
  function scheduleSave() {
    if (timer) return;
    timer = setTimeout(flush, 500);
    if (timer.unref) timer.unref();
  }

  return {
    get(url) { return state[url] || {}; },
    getBody(url) { return bodies.get(url) || null; },
    all() { return state; },

    recordSuccess(url, { status, etag, lastModified, freshMs, itemCount, newestItemAt, payload }, now = Date.now()) {
      const prev = state[url] || {};
      state[url] = {
        lastStatus: status,
        lastCheckedAt: now,
        lastSuccessAt: now,
        consecutiveFailures: 0,
        etag: etag || '',
        lastModified: lastModified || '',
        freshUntil: freshMs > 0 ? now + freshMs : 0,
        itemCount: Number.isFinite(itemCount) ? itemCount : prev.itemCount || 0,
        newestItemAt: newestItemAt || prev.newestItemAt || 0
      };
      if (payload) bodies.set(url, payload);
      scheduleSave();
      return state[url];
    },

    recordFailure(url, { status, error, retryAfterMs }, now = Date.now()) {
      const prev = state[url] || {};
      const failures = (prev.consecutiveFailures || 0) + 1;
      const delay = Math.max(backoffDelay(failures), retryAfterMs || 0);
      state[url] = {
        ...prev,
        lastStatus: status || 0,
        lastCheckedAt: now,
        lastError: String(error || 'fetch failed').slice(0, 200),
        firstFailureAt: prev.consecutiveFailures ? prev.firstFailureAt || now : now,
        consecutiveFailures: failures,
        retryAfterUntil: now + delay,
        freshUntil: 0
      };
      scheduleSave();
      return state[url];
    },

    /** Drop state for feeds no longer in the library. */
    prune(keepUrls) {
      const keep = new Set(keepUrls);
      let changed = false;
      Object.keys(state).forEach((u) => {
        if (!keep.has(u)) { delete state[u]; bodies.delete(u); changed = true; }
      });
      if (changed) scheduleSave();
    },

    flush
  };
}

module.exports = {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_FRESH_MS,
  backoffDelay,
  parseRetryAfter,
  parseFreshness,
  createFeedStateStore
};
