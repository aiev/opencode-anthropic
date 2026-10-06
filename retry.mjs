// Rate-limit handling.
//
// Anthropic reports a `retry-after` header on 429 (and sometimes 503/529)
// responses. OpenCode's retry hook can veto or reshape a retry decision, so
// the http.response hook records the last hint here and the retry hook hands
// it back as the delay instead of letting the client hammer the endpoint.
const RETRY_STATUSES = new Set([429, 503, 529]);
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CAP_MS = 15 * 60 * 1000;
const DEFAULT_FLOOR_MS = 1000;

// `retry-after` is either a number of seconds or an HTTP date.
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

export function createRateLimitState({ ttlMs = DEFAULT_TTL_MS, capMs = DEFAULT_CAP_MS, floorMs = DEFAULT_FLOOR_MS } = {}) {
  let last = null;
  return {
    // Record the hint for a retryable failure; any other status clears it.
    note(response, now = Date.now()) {
      if (!RETRY_STATUSES.has(response?.status)) {
        last = null;
        return last;
      }
      const hint = parseRetryAfter(response.headers?.get?.("retry-after"), now);
      last = { at: now, delayMs: hint };
      return last;
    },
    clear() {
      last = null;
    },
    // Null when there is no fresh, usable hint: the caller should leave the
    // retry decision alone.
    delayMsFor(status, now = Date.now()) {
      if (!RETRY_STATUSES.has(status)) return null;
      if (!last || now - last.at > ttlMs || last.delayMs === null) return null;
      return Math.min(Math.max(last.delayMs, floorMs), capMs);
    },
  };
}
