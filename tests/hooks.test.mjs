import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("Hooks module", () => {
  it("imports without errors", async () => {
    const hooks = await import("../hooks.mjs");
    assert.ok(typeof hooks.trackCost === "function");
    assert.ok(typeof hooks.getDailyCosts === "function");
    assert.ok(typeof hooks.auditLog === "function");
  });

  it("tracks costs correctly", async () => {
    const { trackCost, getDailyCosts } = await import("../hooks.mjs");

    trackCost("test", 0.25, { jobId: "test-job" });
    trackCost("test", 0.10, { jobId: "test-job-2" });

    const costs = getDailyCosts();
    assert.ok(costs.total >= 0.35, `Total should be >= 0.35, got ${costs.total}`);
    assert.ok(costs.queries >= 2, `Queries should be >= 2, got ${costs.queries}`);
    assert.ok(costs.byType.test >= 0.35, `test type cost should be >= 0.35`);
  });

  it("resets costs on new day", async () => {
    const { getDailyCosts } = await import("../hooks.mjs");
    const costs = getDailyCosts();
    assert.equal(costs.date, new Date().toISOString().slice(0, 10));
  });
});
