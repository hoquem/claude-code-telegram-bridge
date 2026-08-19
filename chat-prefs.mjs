/**
 * Per-chat preferences (model/effort overrides) with disk persistence.
 *
 * Kept separate from SessionStore because session rotation deletes the whole
 * session entry — prefs must survive rotation, /reset, and restarts.
 *
 * Shape on disk (prefs.json): { "<chatId>": { "model": "fable", "effort": "high" } }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { dirname, join, basename } from "path";

export class ChatPrefs {
  constructor(filePath, { log } = {}) {
    this.filePath = filePath;
    this.log = log || (() => {});
    this.prefs = new Map();
  }

  load() {
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      for (const [chatId, p] of Object.entries(data)) {
        this.prefs.set(Number(chatId) || chatId, p);
      }
      this.log("info", "chat-prefs-loaded", { count: this.prefs.size });
    } catch (err) {
      this.log("warn", "chat-prefs-load-failed", { error: err.message });
    }
  }

  save() {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmpPath = join(dir, `${basename(this.filePath)}.tmp`);
      writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(this.prefs), null, 2));
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      this.log("warn", "chat-prefs-save-failed", { error: err.message });
    }
  }

  get(chatId) {
    return this.prefs.get(chatId) || {};
  }

  /** Merge a patch into a chat's prefs; a value of null/"auto" clears the key. */
  set(chatId, patch) {
    const current = { ...this.get(chatId) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "auto") delete current[k];
      else current[k] = v;
    }
    if (Object.keys(current).length === 0) this.prefs.delete(chatId);
    else this.prefs.set(chatId, current);
    this.save();
    return current;
  }
}
