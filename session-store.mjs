/**
 * Session persistence + cleanup.
 * Saves sessions to disk so they survive restarts.
 * Periodically purges sessions inactive for >7 days.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { dirname, join, basename } from "path";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_MESSAGES = 50; // auto-rotate after this many messages
const COST_PER_TURN_THRESHOLD = 0.50; // auto-rotate if cost/turn exceeds this

export class SessionStore {
  constructor(filePath, { maxAgeMs = DEFAULT_MAX_AGE_MS, maxMessages = DEFAULT_MAX_MESSAGES, log } = {}) {
    this.filePath = filePath;
    this.maxAgeMs = maxAgeMs;
    this.maxMessages = maxMessages;
    this.log = log || (() => {});
    this.sessions = new Map();
    this.cleanupTimer = null;
  }

  /** Load sessions from disk. Call once at startup. */
  load() {
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      for (const [chatId, session] of Object.entries(data)) {
        this.sessions.set(Number(chatId) || chatId, session);
      }
      this.log("info", "sessions-loaded", { count: this.sessions.size });
    } catch (err) {
      this.log("warn", "sessions-load-failed", { error: err.message });
    }
  }

  /** Persist sessions to disk. Call on shutdown + periodically. */
  save() {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const obj = Object.fromEntries(this.sessions);
      // Atomic write: serialize to a sibling temp file, then rename onto the
      // real path. A crash during a direct writeFileSync leaves a truncated
      // sessions.json that wipes every chat's resume ID on the next restart;
      // rename is atomic on the same filesystem so the live file is either
      // fully old or fully new, never partial.
      const tmpPath = join(dir, `${basename(this.filePath)}.tmp`);
      writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      this.log("warn", "sessions-save-failed", { error: err.message });
    }
  }

  get(chatId) {
    return this.sessions.get(chatId);
  }

  set(chatId, session) {
    this.sessions.set(chatId, session);
  }

  /** Increment message count for a session. Returns the new count. */
  trackMessage(chatId) {
    const session = this.sessions.get(chatId);
    if (session) {
      session.messageCount = (session.messageCount || 0) + 1;
      session.lastActivity = Date.now();
      return session.messageCount;
    }
    return 0;
  }

  /**
   * Check if a session needs rotation based on message count or cost.
   * Returns true if session should be rotated.
   */
  needsRotation(chatId, lastCostPerTurn) {
    const session = this.sessions.get(chatId);
    if (!session?.sessionId) return false;

    // Rotate if message count exceeds threshold
    if ((session.messageCount || 0) >= this.maxMessages) {
      this.log("info", "session-rotation-needed", {
        chatId, reason: "max-messages",
        messageCount: session.messageCount, threshold: this.maxMessages,
      });
      return true;
    }

    // Rotate if cost per turn is too high (bloated context)
    if (lastCostPerTurn && lastCostPerTurn > COST_PER_TURN_THRESHOLD) {
      this.log("info", "session-rotation-needed", {
        chatId, reason: "high-cost-per-turn",
        costPerTurn: lastCostPerTurn, threshold: COST_PER_TURN_THRESHOLD,
      });
      return true;
    }

    return false;
  }

  /** Rotate a session — clear it and return the old session ID for logging. */
  rotate(chatId) {
    const old = this.sessions.get(chatId);
    const oldId = old?.sessionId;
    this.sessions.delete(chatId);
    this.log("info", "session-rotated", { chatId, oldSessionId: oldId });
    return oldId;
  }

  delete(chatId) {
    this.sessions.delete(chatId);
  }

  has(chatId) {
    return this.sessions.has(chatId);
  }

  get size() {
    return this.sessions.size;
  }

  /** Iterate over [chatId, session] pairs (Map-compatible). */
  [Symbol.iterator]() {
    return this.sessions[Symbol.iterator]();
  }

  entries() {
    return this.sessions.entries();
  }

  /** Remove sessions inactive for longer than maxAgeMs. */
  cleanup() {
    const now = Date.now();
    let purged = 0;
    for (const [chatId, session] of this.sessions) {
      if (session.lastActivity && now - session.lastActivity > this.maxAgeMs) {
        this.sessions.delete(chatId);
        purged++;
      }
    }
    if (purged > 0) {
      this.log("info", "sessions-cleanup", { purged, remaining: this.sessions.size });
      this.save();
    }
    return purged;
  }

  /** Start periodic cleanup + auto-save. */
  startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
      this.save(); // periodic persist
    }, CLEANUP_INTERVAL_MS);
    // Don't block process exit
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Stop periodic cleanup. */
  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
