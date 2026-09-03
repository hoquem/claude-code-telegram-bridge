/**
 * Tests for bridge.mjs utility functions.
 * We can't import bridge.mjs directly (it starts the bot), so most tests
 * here mirror its internal logic. The network-error classification, streak/
 * threshold, EPIPE-suppression and zombie-watchdog logic, however, import
 * the REAL implementation from error-classify.mjs (2026-07-06 — a reviewer
 * flagged that local re-implementations of that logic can silently drift
 * from the code they're meant to guard).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isNetworkClassPollingError,
  nextNetworkErrorStreak,
  POLLING_NETWORK_ERROR_EXIT_THRESHOLD,
  isSuppressibleEpipe,
  shouldExitAsZombie,
  ZOMBIE_EPIPE_WATCHDOG_MS,
  PENDING_PROBE_INTERVAL_MS,
} from "../error-classify.mjs";

// ---------------------------------------------------------------------------
// Message chunking logic (mirrors sendLongMessage)
// ---------------------------------------------------------------------------

function chunkMessage(text, maxLen = 4096) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

describe("Message chunking", () => {
  it("returns single chunk for short messages", () => {
    const chunks = chunkMessage("Hello world");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "Hello world");
  });

  it("splits long messages at newlines", () => {
    const line = "x".repeat(2000) + "\n";
    const text = line + line + line; // 6003 chars total
    const chunks = chunkMessage(text, 4096);
    assert.ok(chunks.length >= 2, `Should split into 2+ chunks, got ${chunks.length}`);
    assert.ok(chunks[0].length <= 4096, "Each chunk should be <= maxLen");
  });

  it("handles text without newlines", () => {
    const text = "x".repeat(8000);
    const chunks = chunkMessage(text, 4096);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 4096);
    assert.equal(chunks[1].length, 3904);
  });

  it("handles empty string", () => {
    const chunks = chunkMessage("");
    assert.equal(chunks.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat OK pattern matching (mirrors isHeartbeatOk)
// ---------------------------------------------------------------------------

const HEARTBEAT_OK_PATTERNS = [
  /^heartbeat[_ ]?ok$/i, /^no[_ ]?action/i, /^nothing[_ ]?to[_ ]?report/i,
  /^all[_ ]?clear/i, /^no[_ ]?alerts?/i,
];

function isHeartbeatOk(text) {
  if (!text || text.trim().length === 0) return true;
  const firstLine = text.trim().split("\n")[0].trim();
  return HEARTBEAT_OK_PATTERNS.some((p) => p.test(firstLine));
}

describe("Heartbeat OK detection", () => {
  it("detects heartbeat_ok", () => {
    assert.equal(isHeartbeatOk("HEARTBEAT_OK"), true);
    assert.equal(isHeartbeatOk("heartbeat ok"), true);
    assert.equal(isHeartbeatOk("Heartbeat_Ok"), true);
  });

  it("detects no action needed", () => {
    assert.equal(isHeartbeatOk("no action needed"), true);
    assert.equal(isHeartbeatOk("No_action required"), true);
  });

  it("detects all clear", () => {
    assert.equal(isHeartbeatOk("All clear"), true);
    assert.equal(isHeartbeatOk("all_clear"), true);
  });

  it("detects no alerts", () => {
    assert.equal(isHeartbeatOk("no alerts"), true);
    assert.equal(isHeartbeatOk("No alert"), true);
  });

  it("returns true for empty/null", () => {
    assert.equal(isHeartbeatOk(""), true);
    assert.equal(isHeartbeatOk(null), true);
    assert.equal(isHeartbeatOk(undefined), true);
    assert.equal(isHeartbeatOk("  "), true);
  });

  it("returns false for real alerts", () => {
    assert.equal(isHeartbeatOk("Urgent: Server down"), false);
    assert.equal(isHeartbeatOk("Gmail: 3 unread important emails"), false);
  });

  it("only checks first line", () => {
    assert.equal(isHeartbeatOk("HEARTBEAT_OK\nbut here is some detail"), true);
  });
});

// ---------------------------------------------------------------------------
// Quiet hours logic (mirrors isQuietHours)
// ---------------------------------------------------------------------------

function isQuietHours(hour, quietStart, quietEnd) {
  if (quietStart > quietEnd) {
    return hour >= quietStart || hour < quietEnd;
  }
  return hour >= quietStart && hour < quietEnd;
}

// ---------------------------------------------------------------------------
// Network-class polling error classification (real implementation from
// error-classify.mjs — imports isNetworkClassPollingError, nextNetworkErrorStreak,
// POLLING_NETWORK_ERROR_EXIT_THRESHOLD)
// ---------------------------------------------------------------------------

describe("Network-class polling error classification", () => {
  it("classifies EFATAL as network-class", () => {
    assert.equal(isNetworkClassPollingError({ code: "EFATAL", message: "EFATAL: Error: ESOCKETTIMEDOUT" }), true);
  });

  it("classifies ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN messages as network-class", () => {
    assert.equal(isNetworkClassPollingError({ message: "Error: ECONNRESET" }), true);
    assert.equal(isNetworkClassPollingError({ message: "Error: ETIMEDOUT" }), true);
    assert.equal(isNetworkClassPollingError({ message: "Error: ENOTFOUND api.telegram.org" }), true);
    assert.equal(isNetworkClassPollingError({ message: "Error: EAI_AGAIN" }), true);
  });

  it("classifies raw socket error codes (2026-07-06 fast-follow #2)", () => {
    assert.equal(isNetworkClassPollingError({ code: "ECONNRESET" }), true);
    assert.equal(isNetworkClassPollingError({ code: "EPIPE" }), true);
    assert.equal(isNetworkClassPollingError({ code: "ETIMEDOUT" }), true);
    assert.equal(isNetworkClassPollingError({ code: "ESOCKETTIMEDOUT" }), true);
    assert.equal(isNetworkClassPollingError({ code: "ECONNREFUSED" }), true);
    assert.equal(isNetworkClassPollingError({ code: "ENETUNREACH" }), true);
    assert.equal(isNetworkClassPollingError({ code: "EAI_AGAIN" }), true);
  });

  it("classifies by code even with an unrelated/missing message", () => {
    assert.equal(isNetworkClassPollingError({ code: "ECONNRESET", message: "" }), true);
    assert.equal(isNetworkClassPollingError({ code: "ECONNRESET" }), true);
  });

  it("does NOT classify 409 Conflict as network-class (it is self-healing)", () => {
    assert.equal(isNetworkClassPollingError({ code: "ETELEGRAM", message: "409 Conflict: terminated by other getUpdates request" }), false);
  });

  it("does NOT classify an arbitrary Telegram API error as network-class", () => {
    assert.equal(isNetworkClassPollingError({ code: "ETELEGRAM", message: "400 Bad Request: chat not found" }), false);
  });

  it("returns false for null/undefined", () => {
    assert.equal(isNetworkClassPollingError(null), false);
    assert.equal(isNetworkClassPollingError(undefined), false);
  });
});

describe("Network polling error streak", () => {
  it("increments on consecutive network-class errors", () => {
    let streak = 0;
    for (let i = 0; i < 5; i++) {
      streak = nextNetworkErrorStreak(streak, { code: "EFATAL", message: "EFATAL: Error: ESOCKETTIMEDOUT" });
    }
    assert.equal(streak, 5);
  });

  it("resets to 0 on a non-network-class error (e.g. 409)", () => {
    let streak = 7;
    streak = nextNetworkErrorStreak(streak, { code: "ETELEGRAM", message: "409 Conflict" });
    assert.equal(streak, 0);
  });

  it(`reaches the exit threshold after ${POLLING_NETWORK_ERROR_EXIT_THRESHOLD} consecutive network-class errors`, () => {
    let streak = 0;
    for (let i = 0; i < POLLING_NETWORK_ERROR_EXIT_THRESHOLD - 1; i++) {
      streak = nextNetworkErrorStreak(streak, { code: "EFATAL", message: "EFATAL" });
    }
    assert.equal(streak >= POLLING_NETWORK_ERROR_EXIT_THRESHOLD, false, "should not trip one short of threshold");
    streak = nextNetworkErrorStreak(streak, { code: "EFATAL", message: "EFATAL" });
    assert.equal(streak >= POLLING_NETWORK_ERROR_EXIT_THRESHOLD, true, "should trip at threshold");
  });

  it("a single 409 in the middle of a network-error run resets the streak", () => {
    let streak = 0;
    for (let i = 0; i < 8; i++) {
      streak = nextNetworkErrorStreak(streak, { code: "EFATAL", message: "EFATAL" });
    }
    assert.equal(streak, 8);
    streak = nextNetworkErrorStreak(streak, { code: "ETELEGRAM", message: "409 Conflict" });
    assert.equal(streak, 0);
  });
});

// ---------------------------------------------------------------------------
// EPIPE classification for the uncaughtException safety net (real
// implementation from error-classify.mjs — isSuppressibleEpipe)
// ---------------------------------------------------------------------------

describe("uncaughtException EPIPE safety net scoping", () => {
  it("suppresses a genuine EPIPE error", () => {
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });
    assert.equal(isSuppressibleEpipe(err), true);
  });

  it("does NOT suppress an unrelated error (e.g. TypeError)", () => {
    assert.equal(isSuppressibleEpipe(new TypeError("cannot read properties of undefined")), false);
  });

  it("does NOT suppress a different errno code (e.g. ECONNRESET)", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    assert.equal(isSuppressibleEpipe(err), false);
  });

  it("does NOT suppress a null/undefined-ish thrown value", () => {
    assert.equal(isSuppressibleEpipe(undefined), false);
    assert.equal(isSuppressibleEpipe(null), false);
  });
});

// ---------------------------------------------------------------------------
// Zombie-EPIPE watchdog (real implementation from error-classify.mjs —
// shouldExitAsZombie). Mirrors bridge.mjs: lastEpipeSuppressedAt is set on
// EPIPE suppression, cleared to null on any poll signal (inbound message,
// getMe success, getWebHookInfo success), and checked every 60s.
// ---------------------------------------------------------------------------

describe("Zombie-EPIPE watchdog", () => {
  it("does not exit when no EPIPE has been suppressed (marker is null)", () => {
    assert.equal(shouldExitAsZombie(null, Date.now()), false);
  });

  it("does not exit immediately after a suppression", () => {
    const now = Date.now();
    assert.equal(shouldExitAsZombie(now, now), false);
  });

  it("does not exit just under the threshold", () => {
    const now = Date.now();
    const suppressedAt = now - (ZOMBIE_EPIPE_WATCHDOG_MS - 1000);
    assert.equal(shouldExitAsZombie(suppressedAt, now), false);
  });

  it("exits once the grace window has elapsed with no poll signal", () => {
    const now = Date.now();
    const suppressedAt = now - (ZOMBIE_EPIPE_WATCHDOG_MS + 1000);
    assert.equal(shouldExitAsZombie(suppressedAt, now), true);
  });

  it("respects a custom threshold override", () => {
    const now = Date.now();
    const suppressedAt = now - 1000;
    assert.equal(shouldExitAsZombie(suppressedAt, now, 500), true);
    assert.equal(shouldExitAsZombie(suppressedAt, now, 5000), false);
  });

  it("clearing the marker (poll signal lands) prevents the zombie exit", () => {
    const now = Date.now();
    let lastEpipeSuppressedAt = now - (ZOMBIE_EPIPE_WATCHDOG_MS + 1000);
    // A poll signal (inbound message / successful probe) clears the marker.
    lastEpipeSuppressedAt = null;
    assert.equal(shouldExitAsZombie(lastEpipeSuppressedAt, now), false);
  });

  it("a fresh suppression after a clear restarts the grace window", () => {
    const now = Date.now();
    let lastEpipeSuppressedAt = now - (ZOMBIE_EPIPE_WATCHDOG_MS + 1000);
    lastEpipeSuppressedAt = null; // cleared by a poll signal
    lastEpipeSuppressedAt = now; // a brand new EPIPE gets suppressed right away
    assert.equal(shouldExitAsZombie(lastEpipeSuppressedAt, now), false);
  });

  it("uses strict '>' — exactly at the threshold does NOT exit (2026-07-06 nit)", () => {
    const now = Date.now();
    const suppressedAt = now - ZOMBIE_EPIPE_WATCHDOG_MS;
    assert.equal(shouldExitAsZombie(suppressedAt, now), false);
    // One ms past the threshold does exit.
    assert.equal(shouldExitAsZombie(suppressedAt - 1, now), true);
  });

  it("does not false-trip on a single EPIPE + one transient probe failure (2026-07-06 blocking fix)", () => {
    // Regression for the reviewer-flagged race: EPIPE suppressed right after
    // a probe tick, then the NEXT probe tick fails (catch branch — streak=1,
    // doesn't clear the marker, doesn't exit via the pending-updates path
    // either since that needs 2 consecutive failures). The zombie marker must
    // still be well inside its grace window at that point.
    const probeTickInterval = PENDING_PROBE_INTERVAL_MS;
    const now = Date.now();
    const suppressedAt = now - probeTickInterval; // one probe cycle has passed, one failed
    assert.equal(shouldExitAsZombie(suppressedAt, now), false);
  });
});

describe("Zombie-watchdog / probe-cadence invariant", () => {
  it("the grace window is at least 2 full probe cycles (prevents single-hiccup false positives)", () => {
    // Pins the relationship the 2026-07-06 blocking review finding was
    // about: if a future edit shrinks ZOMBIE_EPIPE_WATCHDOG_MS relative to
    // PENDING_PROBE_INTERVAL_MS without updating both together, this trips
    // instead of silently reintroducing the race.
    assert.ok(
      ZOMBIE_EPIPE_WATCHDOG_MS >= 2 * PENDING_PROBE_INTERVAL_MS,
      `ZOMBIE_EPIPE_WATCHDOG_MS (${ZOMBIE_EPIPE_WATCHDOG_MS}) must be >= 2x PENDING_PROBE_INTERVAL_MS (${PENDING_PROBE_INTERVAL_MS})`
    );
  });
});

// ---------------------------------------------------------------------------
// Pending-updates watchdog tick (mirrors the setInterval body ~line 1354:
// getWebHookInfo() success/failure branches, the probe-failure streak that
// used to no-op, and the 2026-07-05 proof-of-life reset of
// consecutiveNetworkPollingErrors)
// ---------------------------------------------------------------------------

const PENDING_UPDATES_THRESHOLD = 5;

// state: { pendingUpdatesStreak, consecutiveNetworkPollingErrors }
// probe: { ok: true, pending } | { ok: false }
function pendingUpdatesWatchdogTick(state, probe) {
  let { pendingUpdatesStreak, consecutiveNetworkPollingErrors } = state;
  let shouldExit = false;

  if (probe.ok) {
    if (probe.pending > PENDING_UPDATES_THRESHOLD) {
      pendingUpdatesStreak++;
      if (pendingUpdatesStreak >= 2) shouldExit = true;
    } else {
      pendingUpdatesStreak = 0;
      consecutiveNetworkPollingErrors = 0; // proof-of-life reset (also covers quiet hours)
    }
  } else {
    // Probe itself failed — equally strong evidence of a wedged/dead bridge.
    // Pre-2026-07-05 this branch silently did nothing; now it counts.
    pendingUpdatesStreak++;
    if (pendingUpdatesStreak >= 2) shouldExit = true;
  }

  return { pendingUpdatesStreak, consecutiveNetworkPollingErrors, shouldExit };
}

describe("Pending-updates watchdog probe-failure streak (2026-07-05 fix)", () => {
  it("does nothing (no exit) on the first probe failure", () => {
    const result = pendingUpdatesWatchdogTick(
      { pendingUpdatesStreak: 0, consecutiveNetworkPollingErrors: 3 },
      { ok: false }
    );
    assert.equal(result.pendingUpdatesStreak, 1);
    assert.equal(result.shouldExit, false);
  });

  it("exits on the second consecutive probe failure", () => {
    let state = { pendingUpdatesStreak: 0, consecutiveNetworkPollingErrors: 0 };
    state = pendingUpdatesWatchdogTick(state, { ok: false });
    assert.equal(state.shouldExit, false);
    state = pendingUpdatesWatchdogTick(state, { ok: false });
    assert.equal(state.pendingUpdatesStreak, 2);
    assert.equal(state.shouldExit, true);
  });

  it("exits on the second consecutive high-pending-count tick (pre-existing behaviour, unchanged)", () => {
    let state = { pendingUpdatesStreak: 0, consecutiveNetworkPollingErrors: 0 };
    state = pendingUpdatesWatchdogTick(state, { ok: true, pending: 12 });
    assert.equal(state.shouldExit, false);
    state = pendingUpdatesWatchdogTick(state, { ok: true, pending: 12 });
    assert.equal(state.shouldExit, true);
  });

  it("a successful low-pending tick resets both streaks (proof-of-life)", () => {
    const result = pendingUpdatesWatchdogTick(
      { pendingUpdatesStreak: 1, consecutiveNetworkPollingErrors: 9 },
      { ok: true, pending: 0 }
    );
    assert.equal(result.pendingUpdatesStreak, 0);
    assert.equal(result.consecutiveNetworkPollingErrors, 0);
    assert.equal(result.shouldExit, false);
  });

  it("a probe failure does NOT reset the network-error streak (only success does)", () => {
    const result = pendingUpdatesWatchdogTick(
      { pendingUpdatesStreak: 0, consecutiveNetworkPollingErrors: 9 },
      { ok: false }
    );
    assert.equal(result.consecutiveNetworkPollingErrors, 9);
  });

  it("9 accumulated network-class blips + one successful probe no longer trip the exit(1) threshold", () => {
    // Regression for the reviewer-flagged scenario: overnight blips (no
    // inbound messages to reset via the "message" handler) accumulate to 9,
    // then a getWebHookInfo/getMe proof-of-life succeeds — the streak must
    // be back at 0, not 9, so the next unrelated blip doesn't false-trip.
    const afterProbe = pendingUpdatesWatchdogTick(
      { pendingUpdatesStreak: 0, consecutiveNetworkPollingErrors: 9 },
      { ok: true, pending: 1 }
    );
    assert.equal(afterProbe.consecutiveNetworkPollingErrors, 0);

    // One more unrelated blip afterwards is back to streak=1, well under
    // the POLLING_NETWORK_ERROR_EXIT_THRESHOLD of 10.
    const nextStreak = nextNetworkErrorStreak(
      afterProbe.consecutiveNetworkPollingErrors,
      { code: "EFATAL", message: "EFATAL" }
    );
    assert.equal(nextStreak, 1);
  });
});

describe("Quiet hours", () => {
  it("23:00-08:00 — midnight is quiet", () => {
    assert.equal(isQuietHours(0, 23, 8), true);
  });

  it("23:00-08:00 — 3am is quiet", () => {
    assert.equal(isQuietHours(3, 23, 8), true);
  });

  it("23:00-08:00 — 7am is quiet", () => {
    assert.equal(isQuietHours(7, 23, 8), true);
  });

  it("23:00-08:00 — 8am is NOT quiet", () => {
    assert.equal(isQuietHours(8, 23, 8), false);
  });

  it("23:00-08:00 — 10am is NOT quiet", () => {
    assert.equal(isQuietHours(10, 23, 8), false);
  });

  it("23:00-08:00 — 22pm is NOT quiet", () => {
    assert.equal(isQuietHours(22, 23, 8), false);
  });

  it("23:00-08:00 — 23pm IS quiet", () => {
    assert.equal(isQuietHours(23, 23, 8), true);
  });
});

describe("Heartbeat probe resilience", () => {
  it("treats non-2xx status as probe failure (returns null)", () => {
    function processProbeResponse(res) {
      if (!res.ok) return null;
      return "mock-hash";
    }
    assert.equal(processProbeResponse({ ok: false, status: 403 }), null);
    assert.equal(processProbeResponse({ ok: false, status: 500 }), null);
    assert.equal(processProbeResponse({ ok: true, status: 200 }), "mock-hash");
  });

  it("expands leading tilde in path resolution", () => {
    const homedir = "/Users/testuser";
    function expandTilde(filepath) {
      return filepath.replace(/^~(?=\/|$)/, homedir);
    }
    assert.equal(expandTilde("~/clawd/heartbeat.md"), "/Users/testuser/clawd/heartbeat.md");
    assert.equal(expandTilde("~"), "/Users/testuser");
    assert.equal(expandTilde("/var/log/file.txt"), "/var/log/file.txt");
  });
});
