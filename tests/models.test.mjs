/**
 * Tests for models.mjs — tier resolution, pinning, fallback, and the
 * warn-don't-guess behaviour on unrecognized values.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_TIERS,
  EFFORT_LEVELS,
  resolveModelTier,
  resolveModelOr,
  defaultModel,
  pickModel,
  fallbackModelFor,
  usedPrimaryModel,
} from "../models.mjs";

const cfg = {
  fableModel: "claude-fable-5",
  sonnetModel: "claude-sonnet-4-5",
  haikuModel: "claude-haiku-4-5",
  defaultModelTier: "sonnet",
  modelForce: null,
};

/** Collect warnings instead of printing them. */
function warnCollector() {
  const seen = [];
  const fn = (msg) => seen.push(msg);
  fn.seen = seen;
  return fn;
}

// ---------------------------------------------------------------------------

describe("vocabulary", () => {
  it("exposes the tiers /model accepts", () => {
    assert.deepEqual(MODEL_TIERS, ["fable", "sonnet", "haiku", "auto"]);
  });

  it("exposes the levels /effort accepts", () => {
    assert.deepEqual(EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max", "auto"]);
  });
});

describe("resolveModelTier", () => {
  it("maps each tier name to its configured id", () => {
    assert.equal(resolveModelTier("fable", cfg), cfg.fableModel);
    assert.equal(resolveModelTier("sonnet", cfg), cfg.sonnetModel);
    assert.equal(resolveModelTier("haiku", cfg), cfg.haikuModel);
  });

  it("returns null for auto, unknown values, and nothing at all", () => {
    assert.equal(resolveModelTier("auto", cfg), null);
    assert.equal(resolveModelTier("bogus", cfg), null);
    assert.equal(resolveModelTier(undefined, cfg), null);
    assert.equal(resolveModelTier(null, cfg), null);
  });
});

describe("defaultModel", () => {
  it("resolves the configured default tier", () => {
    assert.equal(defaultModel(cfg), cfg.sonnetModel);
    assert.equal(defaultModel({ ...cfg, defaultModelTier: "haiku" }), cfg.haikuModel);
  });

  it("falls back to sonnet when the default tier itself is nonsense", () => {
    assert.equal(defaultModel({ ...cfg, defaultModelTier: "nope" }), cfg.sonnetModel);
  });
});

describe("resolveModelOr", () => {
  it("resolves a tier name without warning", () => {
    const warn = warnCollector();
    assert.equal(resolveModelOr("fable", "test", warn, cfg), cfg.fableModel);
    assert.deepEqual(warn.seen, []);
  });

  it("passes a full claude-* id through untouched", () => {
    const warn = warnCollector();
    assert.equal(
      resolveModelOr("claude-sonnet-4-5-20250929", "test", warn, cfg),
      "claude-sonnet-4-5-20250929"
    );
    assert.deepEqual(warn.seen, []);
  });

  it("treats absent as unpinned, not as an error", () => {
    const warn = warnCollector();
    assert.equal(resolveModelOr(null, "test", warn, cfg), cfg.sonnetModel);
    assert.equal(resolveModelOr(undefined, "test", warn, cfg), cfg.sonnetModel);
    assert.deepEqual(warn.seen, []);
  });

  // The point of the whole function: a typo must be loud. Silently running an
  // agent pinned to "sonnett" on the default tier is how that typo survives
  // for months. ("opus" is a real alias; see the vocabulary suite below.)
  it("warns and uses the default tier for an unrecognized value", () => {
    const warn = warnCollector();
    assert.equal(resolveModelOr("sonnett", "agents: reviewer.md", warn, cfg), cfg.sonnetModel);
    assert.equal(warn.seen.length, 1);
    assert.match(warn.seen[0], /agents: reviewer\.md/);
    assert.match(warn.seen[0], /sonnett/);
  });
});

// Subagent files are authored for the CLI, where opus/inherit are the normal
// things to write. Not understanding them sent every agent pinned to the
// strongest model quietly down to the default tier.
describe("Claude Code frontmatter vocabulary", () => {
  it("maps opus to the top tier", () => {
    const warn = warnCollector();
    assert.equal(resolveModelOr("opus", "agents: x.md", warn, cfg), cfg.fableModel);
    assert.deepEqual(warn.seen, [], "opus is valid input, not a typo");
  });

  it("treats inherit as the default tier, without warning", () => {
    const warn = warnCollector();
    assert.equal(resolveModelOr("inherit", "agents: x.md", warn, cfg), cfg.sonnetModel);
    assert.deepEqual(warn.seen, []);
  });

  it("resolves opus through resolveModelTier too", () => {
    assert.equal(resolveModelTier("opus", cfg), cfg.fableModel);
  });

  it("still warns on something that is genuinely not a model", () => {
    const warn = warnCollector();
    assert.equal(resolveModelOr("gpt-4", "agents: x.md", warn, cfg), cfg.sonnetModel);
    assert.equal(warn.seen.length, 1);
  });
});

describe("pickModel", () => {
  it("uses the pin when there is one", () => {
    assert.equal(pickModel("haiku", "test", () => {}, cfg), cfg.haikuModel);
  });

  it("uses the default tier when nothing is pinned", () => {
    assert.equal(pickModel(null, "test", () => {}, cfg), cfg.sonnetModel);
  });

  // The kill switch has to beat everything, or a rollback isn't a rollback.
  it("ANTHROPIC_MODEL_FORCE overrides every pin", () => {
    const forced = { ...cfg, modelForce: "claude-sonnet-4-5" };
    assert.equal(pickModel("fable", "test", () => {}, forced), "claude-sonnet-4-5");
    assert.equal(pickModel("haiku", "test", () => {}, forced), "claude-sonnet-4-5");
    assert.equal(pickModel(null, "test", () => {}, forced), "claude-sonnet-4-5");
    assert.equal(pickModel("claude-fable-5", "test", () => {}, forced), "claude-sonnet-4-5");
  });
});

describe("fallbackModelFor", () => {
  it("steps fable down to sonnet", () => {
    assert.equal(fallbackModelFor(cfg.fableModel, cfg), cfg.sonnetModel);
  });

  it("steps sonnet down to haiku", () => {
    assert.equal(fallbackModelFor(cfg.sonnetModel, cfg), cfg.haikuModel);
  });

  // Haiku is the bottom tier, so it falls back *up* — a different capacity
  // pool is the whole point, and returning haiku would make it a no-op.
  it("steps haiku up to sonnet rather than to itself", () => {
    assert.equal(fallbackModelFor(cfg.haikuModel, cfg), cfg.sonnetModel);
  });

  it("never returns the primary, for any tier or unknown id", () => {
    for (const m of [cfg.fableModel, cfg.sonnetModel, cfg.haikuModel, "claude-opus-4-8"]) {
      assert.notEqual(fallbackModelFor(m, cfg), m);
    }
  });
});

describe("usedPrimaryModel", () => {
  it("matches an exact model id", () => {
    assert.equal(usedPrimaryModel("claude-sonnet-4-5", ["claude-sonnet-4-5"]), true);
  });

  // modelUsage reports dated ids; a strict equality check would warn
  // "primary-model-not-used" on every query and bury the real fallbacks.
  it("matches a dated/resolved snapshot of the routed alias", () => {
    assert.equal(usedPrimaryModel("claude-sonnet-4-5", ["claude-sonnet-4-5-20250929"]), true);
  });

  it("does not match a different tier (real fallback engagement)", () => {
    assert.equal(usedPrimaryModel("claude-fable-5", ["claude-sonnet-4-5-20250929"]), false);
  });

  it("does not match across tiers even with shared prefixes", () => {
    assert.equal(usedPrimaryModel("claude-haiku-4-5", ["claude-sonnet-4-5"]), false);
  });

  it("matches when the primary appears alongside subagent models", () => {
    assert.equal(usedPrimaryModel("claude-fable-5", ["claude-haiku-4-5", "claude-fable-5-20260101"]), true);
  });

  it("empty usage list means not used", () => {
    assert.equal(usedPrimaryModel("claude-sonnet-4-5", []), false);
  });
});
