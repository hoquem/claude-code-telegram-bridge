/**
 * Resilience primitives for the Telegram bridge.
 *
 * Pure/testable helpers shared by bridge.mjs and cron-jobs.mjs:
 *   - Semaphore            — global concurrency cap on SDK subprocesses
 *   - RejectionTracker     — sliding-window escalation for unhandledRejection
 *   - sdkResilienceEnv     — Agent SDK stream-watchdog / retry env vars
 *   - staleThresholdMs     — polling-staleness threshold by hour (quiet-hours multiplier)
 *   - sweepStaleDownloads  — startup cleanup of leaked download files
 */

import { readdirSync, statSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Semaphore — FIFO concurrency gate for SDK query() subprocesses.
//
// Each query() spawns a ~300 MB claude subprocess. Without a cap, N chats
// (plus cron + heartbeat) can each spawn one simultaneously and push the
// host into swap. Callers MUST release() in a finally block.
// ---------------------------------------------------------------------------

export class Semaphore {
  constructor(max) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`Semaphore max must be a positive integer, got ${max}`);
    this.max = max;
    this.inUse = 0;
    this.waiters = [];
  }

  get active() { return this.inUse; }
  get queued() { return this.waiters.length; }

  /** Resolves when a slot is available. FIFO order. */
  acquire() {
    if (this.inUse < this.max) {
      this.inUse++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Like acquire(), but gives up after timeoutMs. Resolves true when the
   * slot was acquired (caller MUST release()), false when the wait timed
   * out (caller MUST NOT release()). Lets periodic work (heartbeat) skip a
   * busy tick instead of parking unbounded in the FIFO queue.
   */
  acquireWithin(timeoutMs) {
    if (this.inUse < this.max) {
      this.inUse++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        // Not found means release() already handed us the slot — waiter()
        // has resolved true and this callback is a stale no-op.
        if (i !== -1) {
          this.waiters.splice(i, 1);
          resolve(false);
        }
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Release a slot; hands it directly to the oldest waiter if any. */
  release() {
    const next = this.waiters.shift();
    if (next) {
      // Slot transfers to the waiter — inUse count unchanged.
      next();
    } else {
      this.inUse = Math.max(0, this.inUse - 1);
    }
  }
}

// Shared singleton: ALL SDK query() call sites (interactive runClaude,
// heartbeat, cron jobs) must acquire this before spawning a subprocess.
// Living here (not in bridge.mjs) so cron-jobs.mjs can import it without a
// circular dependency on bridge.mjs.
export const querySemaphore = new Semaphore(Number(process.env.MAX_CONCURRENT_QUERIES) || 3);

// ---------------------------------------------------------------------------
// RejectionTracker — sliding-window counter for unhandledRejection storms.
//
// A single unhandled rejection is logged and survivable; a storm of them
// means the process is in an undefined state and a clean launchd restart
// is safer than limping on. record() returns true when the threshold is
// crossed within the window.
// ---------------------------------------------------------------------------

export class RejectionTracker {
  constructor({ threshold = 10, windowMs = 5 * 60_000 } = {}) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  /** Record one rejection at `now`. Returns true if the process should exit. */
  record(now = Date.now()) {
    this.timestamps.push(now);
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
    return this.timestamps.length >= this.threshold;
  }

  get count() { return this.timestamps.length; }
}

// ---------------------------------------------------------------------------
// Agent SDK resilience env vars.
//
// The 0.3.x SDK subprocess honours these: the stream watchdog kills a wedged
// SSE stream instead of hanging the query forever; MAX_RETRIES controls
// transport-level retries. Explicit env vars (set by the operator) always
// win over these defaults.
//
// Deliberately NOT defaulted: API_TIMEOUT_MS. The SDK's own per-request
// timeout (~10 min) already bounds a single request, and a lower value would
// kill long Fable-5 deep-research turns that legitimately stream for many
// minutes. The 10-min idle timeout below is a wedge detector, not a turn
// limit — a healthy long turn emits stream events throughout.
// ---------------------------------------------------------------------------

export function sdkResilienceEnv(env = process.env) {
  const out = {
    CLAUDE_ENABLE_STREAM_WATCHDOG: env.CLAUDE_ENABLE_STREAM_WATCHDOG ?? "1",
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: env.CLAUDE_STREAM_IDLE_TIMEOUT_MS ?? "600000",
    CLAUDE_CODE_MAX_RETRIES: env.CLAUDE_CODE_MAX_RETRIES ?? "3",
  };
  if (env.API_TIMEOUT_MS) out.API_TIMEOUT_MS = env.API_TIMEOUT_MS;
  return out;
}

// ---------------------------------------------------------------------------
// Polling-staleness threshold by hour.
//
// Historically the staleness watchdog was disabled 23:00-08:00 to avoid
// false positives on idle nights — which left a coverage hole: a wedge with
// zero pending updates overnight went uncaught until 08:00. Now that the
// getWebHookInfo probe refreshes lastPollSignalAt 24/7, the watchdog can run
// overnight too; the quiet-hours multiplier just makes it more tolerant.
// ---------------------------------------------------------------------------

export function staleThresholdMs(hour, baseMs, { quietStart = 23, quietEnd = 8, quietMultiplier = 3 } = {}) {
  const isQuiet = quietStart > quietEnd
    ? (hour >= quietStart || hour < quietEnd)
    : (hour >= quietStart && hour < quietEnd);
  return isQuiet ? baseMs * quietMultiplier : baseMs;
}

// ---------------------------------------------------------------------------
// Stale-download sweep.
//
// Files downloaded from Telegram are normally deleted in finally blocks, but
// a crash between download and cleanup leaks them. Run once at startup.
// ---------------------------------------------------------------------------

export function sweepStaleDownloads(dir, maxAgeMs = 60 * 60_000, now = Date.now()) {
  const result = { swept: 0, errors: 0 };
  if (!existsSync(dir)) return result;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    result.errors++;
    return result;
  }
  for (const name of names) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > maxAgeMs) {
        unlinkSync(p);
        result.swept++;
      }
    } catch {
      result.errors++;
    }
  }
  return result;
}
