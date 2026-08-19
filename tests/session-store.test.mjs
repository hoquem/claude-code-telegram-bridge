import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../session-store.mjs";

const TEST_DIR = join(tmpdir(), "session-store-test-" + Date.now());
const TEST_FILE = join(TEST_DIR, "sessions.json");

describe("SessionStore", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
  });

  afterEach(() => {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
  });

  it("stores and retrieves sessions", () => {
    const store = new SessionStore(TEST_FILE);
    store.set(123, { sessionId: "s1", lastActivity: Date.now() });

    assert.equal(store.size, 1);
    assert.equal(store.get(123).sessionId, "s1");
    assert.equal(store.has(123), true);
    assert.equal(store.has(999), false);
  });

  it("persists sessions to disk and loads them", () => {
    const store1 = new SessionStore(TEST_FILE);
    store1.set(100, { sessionId: "abc", lastActivity: Date.now() });
    store1.set(200, { sessionId: "def", lastActivity: Date.now() });
    store1.save();

    const store2 = new SessionStore(TEST_FILE);
    store2.load();

    assert.equal(store2.size, 2);
    assert.equal(store2.get(100).sessionId, "abc");
    assert.equal(store2.get(200).sessionId, "def");
  });

  it("handles missing file on load gracefully", () => {
    const store = new SessionStore(join(TEST_DIR, "nonexistent.json"));
    store.load(); // Should not throw
    assert.equal(store.size, 0);
  });

  it("handles corrupt file on load gracefully", () => {
    writeFileSync(TEST_FILE, "not json{{{");
    const logs = [];
    const store = new SessionStore(TEST_FILE, { log: (level, msg) => logs.push({ level, msg }) });
    store.load();
    assert.equal(store.size, 0);
    assert.equal(logs.some((l) => l.level === "warn"), true);
  });

  it("deletes sessions", () => {
    const store = new SessionStore(TEST_FILE);
    store.set(1, { sessionId: "x", lastActivity: Date.now() });
    store.delete(1);
    assert.equal(store.size, 0);
    assert.equal(store.has(1), false);
  });

  it("cleans up stale sessions", () => {
    const store = new SessionStore(TEST_FILE, { maxAgeMs: 1000 });
    const old = Date.now() - 5000; // 5 seconds ago
    const recent = Date.now();

    store.set(1, { sessionId: "old", lastActivity: old });
    store.set(2, { sessionId: "recent", lastActivity: recent });

    const purged = store.cleanup();
    assert.equal(purged, 1);
    assert.equal(store.size, 1);
    assert.equal(store.has(1), false);
    assert.equal(store.has(2), true);
  });

  it("cleanup returns 0 when nothing to purge", () => {
    const store = new SessionStore(TEST_FILE, { maxAgeMs: 100_000 });
    store.set(1, { sessionId: "s1", lastActivity: Date.now() });
    assert.equal(store.cleanup(), 0);
    assert.equal(store.size, 1);
  });

  it("is iterable", () => {
    const store = new SessionStore(TEST_FILE);
    store.set(1, { sessionId: "a", lastActivity: 1 });
    store.set(2, { sessionId: "b", lastActivity: 2 });

    const entries = [...store];
    assert.equal(entries.length, 2);
  });

  it("starts and stops cleanup timer", () => {
    const store = new SessionStore(TEST_FILE);
    store.startCleanupTimer();
    assert.notEqual(store.cleanupTimer, null);
    store.stopCleanupTimer();
    assert.equal(store.cleanupTimer, null);
  });
});
