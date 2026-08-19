/**
 * Tests for resilience.mjs — Semaphore, RejectionTracker, sdkResilienceEnv,
 * staleThresholdMs, sweepStaleDownloads.
 *
 * Model fallback and usage checks moved to models.mjs; see
 * tests/models.test.mjs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  Semaphore,
  querySemaphore,
  RejectionTracker,
  sdkResilienceEnv,
  staleThresholdMs,
  sweepStaleDownloads,
} from "../resilience.mjs";

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

describe("Semaphore", () => {
  it("rejects invalid max", () => {
    assert.throws(() => new Semaphore(0));
    assert.throws(() => new Semaphore(-1));
    assert.throws(() => new Semaphore(1.5));
  });

  it("allows up to max concurrent acquires without waiting", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    assert.equal(sem.active, 2);
    assert.equal(sem.queued, 0);
  });

  it("queues acquires beyond max", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    let acquired = false;
    const p = sem.acquire().then(() => { acquired = true; });
    // Give the microtask queue a tick — must still be queued
    await new Promise((r) => setImmediate(r));
    assert.equal(acquired, false);
    assert.equal(sem.queued, 1);
    sem.release();
    await p;
    assert.equal(acquired, true);
    assert.equal(sem.queued, 0);
    assert.equal(sem.active, 1); // slot transferred to the waiter
  });

  it("wakes waiters in FIFO order", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const order = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));
    sem.release(); await p1;
    sem.release(); await p2;
    sem.release(); await p3;
    assert.deepEqual(order, [1, 2, 3]);
  });

  it("release without waiters frees the slot", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    sem.release();
    assert.equal(sem.active, 0);
    // slot reusable
    await sem.acquire();
    assert.equal(sem.active, 1);
  });

  it("release never drives active below zero", () => {
    const sem = new Semaphore(1);
    sem.release();
    sem.release();
    assert.equal(sem.active, 0);
  });

  it("exports a shared singleton for all query call sites", () => {
    assert.ok(querySemaphore instanceof Semaphore);
    assert.ok(querySemaphore.max >= 1);
  });

  describe("acquireWithin", () => {
    it("resolves true immediately when a slot is free", async () => {
      const sem = new Semaphore(1);
      assert.equal(await sem.acquireWithin(50), true);
      assert.equal(sem.active, 1);
    });

    it("resolves false after the timeout and removes the waiter", async () => {
      const sem = new Semaphore(1);
      await sem.acquire();
      const acquired = await sem.acquireWithin(20);
      assert.equal(acquired, false);
      assert.equal(sem.queued, 0); // waiter removed, not leaked
      // The held slot is untouched; releasing frees it normally.
      sem.release();
      assert.equal(sem.active, 0);
    });

    it("resolves true when a slot frees up before the timeout", async () => {
      const sem = new Semaphore(1);
      await sem.acquire();
      const p = sem.acquireWithin(5_000);
      sem.release();
      assert.equal(await p, true);
      assert.equal(sem.active, 1); // slot transferred to the timed waiter
    });

    it("a timed-out waiter does not steal a later release from FIFO waiters", async () => {
      const sem = new Semaphore(1);
      await sem.acquire();
      assert.equal(await sem.acquireWithin(10), false);
      let acquired = false;
      const p = sem.acquire().then(() => { acquired = true; });
      sem.release();
      await p;
      assert.equal(acquired, true);
    });
  });
});

// ---------------------------------------------------------------------------
// RejectionTracker
// ---------------------------------------------------------------------------

describe("RejectionTracker", () => {
  it("stays below threshold for isolated rejections", () => {
    const t = new RejectionTracker({ threshold: 3, windowMs: 1000 });
    assert.equal(t.record(0), false);
    assert.equal(t.record(100), false);
  });

  it("fires when threshold reached within window", () => {
    const t = new RejectionTracker({ threshold: 3, windowMs: 1000 });
    t.record(0);
    t.record(100);
    assert.equal(t.record(200), true);
  });

  it("expires entries outside the window", () => {
    const t = new RejectionTracker({ threshold: 3, windowMs: 1000 });
    t.record(0);
    t.record(100);
    // Third arrives after the first two have aged out
    assert.equal(t.record(2000), false);
    assert.equal(t.count, 1);
  });
});

// ---------------------------------------------------------------------------
// sdkResilienceEnv
// ---------------------------------------------------------------------------

describe("sdkResilienceEnv", () => {
  it("returns watchdog defaults when env is empty", () => {
    const env = sdkResilienceEnv({});
    assert.equal(env.CLAUDE_ENABLE_STREAM_WATCHDOG, "1");
    assert.equal(env.CLAUDE_STREAM_IDLE_TIMEOUT_MS, "600000");
    assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "3");
  });

  it("never defaults API_TIMEOUT_MS (would kill long Fable turns)", () => {
    const env = sdkResilienceEnv({});
    assert.equal("API_TIMEOUT_MS" in env, false);
  });

  it("operator-set env vars win over defaults and pass through", () => {
    const env = sdkResilienceEnv({
      CLAUDE_ENABLE_STREAM_WATCHDOG: "0",
      API_TIMEOUT_MS: "60000",
    });
    assert.equal(env.CLAUDE_ENABLE_STREAM_WATCHDOG, "0");
    assert.equal(env.API_TIMEOUT_MS, "60000");
    assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "3"); // untouched default
  });
});

// ---------------------------------------------------------------------------
// staleThresholdMs
// ---------------------------------------------------------------------------

describe("staleThresholdMs", () => {
  const BASE = 30 * 60_000;

  it("waking hours use the base threshold", () => {
    for (const hour of [8, 12, 18, 22]) {
      assert.equal(staleThresholdMs(hour, BASE), BASE);
    }
  });

  it("quiet hours (23:00-08:00) use the 3x multiplier", () => {
    for (const hour of [23, 0, 3, 7]) {
      assert.equal(staleThresholdMs(hour, BASE), BASE * 3);
    }
  });

  it("boundary: 8am is waking, 11pm is quiet", () => {
    assert.equal(staleThresholdMs(8, BASE), BASE);
    assert.equal(staleThresholdMs(23, BASE), BASE * 3);
  });

  it("supports custom quiet window and multiplier", () => {
    assert.equal(staleThresholdMs(2, BASE, { quietStart: 1, quietEnd: 5, quietMultiplier: 2 }), BASE * 2);
    assert.equal(staleThresholdMs(6, BASE, { quietStart: 1, quietEnd: 5, quietMultiplier: 2 }), BASE);
  });
});

// ---------------------------------------------------------------------------
// sweepStaleDownloads
// ---------------------------------------------------------------------------

describe("sweepStaleDownloads", () => {
  it("removes files older than maxAge, keeps fresh ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-test-"));
    try {
      const oldFile = join(dir, "old.jpg");
      const newFile = join(dir, "new.jpg");
      writeFileSync(oldFile, "x");
      writeFileSync(newFile, "y");
      // Backdate old.jpg by 2 hours
      const twoHoursAgo = (Date.now() - 2 * 60 * 60_000) / 1000;
      utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

      const result = sweepStaleDownloads(dir, 60 * 60_000);
      assert.equal(result.swept, 1);
      assert.equal(result.errors, 0);
      assert.equal(existsSync(oldFile), false);
      assert.equal(existsSync(newFile), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns zeros for a missing directory", () => {
    const result = sweepStaleDownloads("/nonexistent/path/xyz", 1000);
    assert.deepEqual(result, { swept: 0, errors: 0 });
  });
});
