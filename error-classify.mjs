/**
 * Shared error-classification + streak/threshold logic for the bridge's
 * polling-error and EPIPE-crash watchdogs (bridge.mjs).
 *
 * Extracted 2026-07-06 (PR #15 fast-follow #3) so tests can import the real
 * implementation instead of re-implementing it locally — a reviewer flagged
 * that local test re-implementations can silently drift from the code they're
 * meant to guard. Pure functions only, no side effects, mirrors the style of
 * model-router.mjs's pickModel().
 */

// ---------------------------------------------------------------------------
// Network-class polling error classification
// ---------------------------------------------------------------------------

// Raw socket / DNS / ntba-fatal error codes that indicate a dead transport
// rather than a normal Telegram API rejection. 409 Conflict / other 4xx
// Telegram API errors are ETELEGRAM-coded and deliberately excluded — those
// are self-healing (see the polling_error handler in bridge.mjs) and must
// never count toward the wedged-connection exit streak.
export const NETWORK_POLLING_ERROR_CODES = new Set([
  "EFATAL",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

// Fallback for errors that carry the signal only in .message (some
// node-telegram-bot-api wrapper errors don't set a clean .code). ENOTFOUND
// kept here rather than in the code set — DNS failures surface this way on
// this stack more often than as a bare err.code.
export const NETWORK_POLLING_ERROR_MESSAGE_RE =
  /EFATAL|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|ENETUNREACH|ENOTFOUND|EAI_AGAIN/;

/**
 * True if `err` represents a dead-transport / network-class failure rather
 * than a normal (self-healing) Telegram API rejection.
 * @param {Error|{code?: string, message?: string}|null|undefined} err
 * @returns {boolean}
 */
export function isNetworkClassPollingError(err) {
  if (!err) return false;
  if (NETWORK_POLLING_ERROR_CODES.has(err.code)) return true;
  return NETWORK_POLLING_ERROR_MESSAGE_RE.test(err.message || "");
}

// How many consecutive network-class polling errors before we treat the
// connection as wedged rather than blip-y. Override with
// POLLING_NETWORK_ERROR_EXIT_THRESHOLD.
export const POLLING_NETWORK_ERROR_EXIT_THRESHOLD =
  Number(process.env.POLLING_NETWORK_ERROR_EXIT_THRESHOLD) || 10;

/**
 * Running-streak update for consecutive network-class polling errors.
 * Bumps on a network-class error, resets to 0 on anything else (e.g. 409
 * Conflict, which must not count — it's self-healing).
 * @param {number} currentStreak
 * @param {Error|{code?: string, message?: string}} err
 * @returns {number} next streak value
 */
export function nextNetworkErrorStreak(currentStreak, err) {
  return isNetworkClassPollingError(err) ? currentStreak + 1 : 0;
}

// ---------------------------------------------------------------------------
// EPIPE-suppression predicate (uncaughtException safety net)
// ---------------------------------------------------------------------------

/**
 * True only for a genuine EPIPE — the narrow condition the uncaughtException
 * safety net is allowed to suppress. Everything else must still crash/exit.
 * @param {Error|{code?: string}|null|undefined} err
 * @returns {boolean}
 */
export function isSuppressibleEpipe(err) {
  return Boolean(err && err.code === "EPIPE");
}

// ---------------------------------------------------------------------------
// Zombie-EPIPE watchdog
//
// Suppressing an EPIPE is a bet that the underlying process is still alive
// and useful (e.g. a dead keep-alive socket the library will reconnect on
// its own). That bet is unproven at suppression time. If NO poll signal
// (inbound message, or a successful getMe/getWebHookInfo proof-of-life
// probe) lands within a grace window afterwards, the suppression more likely
// masked a genuinely dead process — treat it as a zombie and exit so launchd
// cold-starts a fresh one.
// ---------------------------------------------------------------------------

// Cadence of the getWebHookInfo proof-of-life probe in bridge.mjs (also used
// for its setInterval call — see PENDING_PROBE_INTERVAL_MS import there).
// Named here rather than left as a bare literal so the zombie-watchdog grace
// window below can derive from it and the "grace window >= 2x probe
// interval" invariant can't silently drift out of sync if one changes
// without the other (2026-07-06 reviewer finding: a 5-min grace window equal
// to the probe cadence meant one suppressed EPIPE + one transient probe
// hiccup could zombie-exit a perfectly healthy process).
export const PENDING_PROBE_INTERVAL_MS =
  Number(process.env.PENDING_PROBE_INTERVAL_MS) || 5 * 60 * 1000;

// Must clear at least 2 full probe cycles (so a single missed/failed probe
// tick can't cause a false positive) plus the 60s watchdog check granularity,
// with a little margin. Default: 2*5min + 1min = 11 min.
export const ZOMBIE_EPIPE_WATCHDOG_MS =
  Number(process.env.ZOMBIE_EPIPE_WATCHDOG_MS) || (2 * PENDING_PROBE_INTERVAL_MS + 60_000);

/**
 * @param {number|null} lastEpipeSuppressedAt - ms epoch of the last
 *   suppressed EPIPE, or null if none is outstanding / it's already been
 *   cleared by a subsequent poll signal.
 * @param {number} now - current ms epoch (passed explicitly so this stays a
 *   pure, easily-testable function).
 * @param {number} [thresholdMs] - grace window; defaults to
 *   ZOMBIE_EPIPE_WATCHDOG_MS.
 * @returns {boolean} true if the process should be treated as a zombie.
 */
export function shouldExitAsZombie(lastEpipeSuppressedAt, now, thresholdMs = ZOMBIE_EPIPE_WATCHDOG_MS) {
  if (lastEpipeSuppressedAt == null) return false;
  return now - lastEpipeSuppressedAt > thresholdMs;
}
