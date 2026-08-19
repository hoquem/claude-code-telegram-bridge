/**
 * Tests for chat-prefs.mjs — per-chat model/effort overrides.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ChatPrefs } from "../chat-prefs.mjs";
import { MODEL_TIERS, EFFORT_LEVELS, resolveModelTier } from "../models.mjs";

const cfg = {
  fableModel: "claude-fable-5",
  sonnetModel: "claude-sonnet-4-5",
  haikuModel: "claude-haiku-4-5",
};

describe("resolveModelTier", () => {
  it("maps tier names to config model ids", () => {
    assert.equal(resolveModelTier("fable", cfg), cfg.fableModel);
    assert.equal(resolveModelTier("sonnet", cfg), cfg.sonnetModel);
    assert.equal(resolveModelTier("haiku", cfg), cfg.haikuModel);
  });

  it("returns null for auto/unknown/undefined", () => {
    assert.equal(resolveModelTier("auto", cfg), null);
    assert.equal(resolveModelTier("bogus", cfg), null);
    assert.equal(resolveModelTier(undefined, cfg), null);
  });
});

describe("tier/effort constants", () => {
  it("expose the documented values", () => {
    assert.deepEqual(MODEL_TIERS, ["fable", "sonnet", "haiku", "auto"]);
    assert.deepEqual(EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max", "auto"]);
  });
});

describe("ChatPrefs", () => {
  function tempStore() {
    const dir = mkdtempSync(join(tmpdir(), "prefs-test-"));
    return { dir, prefs: new ChatPrefs(join(dir, "prefs.json")) };
  }

  it("get returns empty object for unknown chat", () => {
    const { dir, prefs } = tempStore();
    try {
      assert.deepEqual(prefs.get(123), {});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("set merges patches and persists", () => {
    const { dir, prefs } = tempStore();
    try {
      prefs.set(123, { model: "fable" });
      prefs.set(123, { effort: "high" });
      assert.deepEqual(prefs.get(123), { model: "fable", effort: "high" });

      // Round-trip through disk
      const reloaded = new ChatPrefs(join(dir, "prefs.json"));
      reloaded.load();
      assert.deepEqual(reloaded.get(123), { model: "fable", effort: "high" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("null or 'auto' clears a key; empty prefs drop the chat entry", () => {
    const { dir, prefs } = tempStore();
    try {
      prefs.set(123, { model: "fable", effort: "high" });
      prefs.set(123, { model: "auto" });
      assert.deepEqual(prefs.get(123), { effort: "high" });
      prefs.set(123, { effort: null });
      assert.deepEqual(prefs.get(123), {});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("tolerates a corrupt prefs file", () => {
    const { dir } = tempStore();
    try {
      const file = join(dir, "prefs.json");
      writeFileSync(file, "{not json");
      const prefs = new ChatPrefs(file);
      prefs.load(); // must not throw
      assert.deepEqual(prefs.get(1), {});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
