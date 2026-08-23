/**
 * Tests for cron-jobs.mjs — job loading and validation, and per-job model
 * pinning.
 *
 * Nothing here runs a real Claude query; the scheduler's execution path needs
 * the SDK and is exercised in deployment, not in unit tests.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const EXAMPLE_JOBS = fileURLToPath(new URL("../cron-jobs.example.mjs", import.meta.url));

let loadCronJobs, pickModelForCron, setCronDeps;
let tmp;

before(async () => {
  const mod = await import("../cron-jobs.mjs");
  loadCronJobs = mod.loadCronJobs;
  pickModelForCron = mod.pickModelForCron;
  setCronDeps = mod.setCronDeps;
  // Silence the module's logger so a passing run isn't buried in JSON.
  setCronDeps({ log: () => {}, sendLongMessage: async () => {} });
  tmp = mkdtempSync(join(tmpdir(), "cron-jobs-test-"));
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Write a jobs module to a temp file and return its path. */
function jobsFile(name, source) {
  const path = join(tmp, name);
  writeFileSync(path, source);
  return path;
}

// ---------------------------------------------------------------------------

describe("loadCronJobs", () => {
  it("schedules nothing when no jobs file is configured", async () => {
    assert.deepEqual(await loadCronJobs(null), []);
  });

  it("loads the shipped example file", async () => {
    const jobs = await loadCronJobs(EXAMPLE_JOBS);
    assert.ok(jobs.length > 0, "example file should define at least one job");
    for (const job of jobs) {
      assert.ok(job.id, "every example job needs an id");
      assert.ok(job.schedule, "every example job needs a schedule");
      assert.ok(job.prompt, "every example job needs a prompt");
    }
  });

  it("accepts an array prompt as well as a string", async () => {
    const jobs = await loadCronJobs(EXAMPLE_JOBS);
    const kinds = new Set(jobs.map((j) => (Array.isArray(j.prompt) ? "array" : "string")));
    assert.ok(kinds.has("array") && kinds.has("string"),
      "the example should demonstrate both prompt forms");
  });

  // A configured-but-broken jobs file is a deployment error. Booting with an
  // empty schedule would look identical to booting correctly, and the jobs
  // would just never run.
  it("throws when the configured file does not exist", async () => {
    await assert.rejects(
      () => loadCronJobs(join(tmp, "does-not-exist.mjs")),
      /could not be loaded/
    );
  });

  it("throws when the file does not export an array", async () => {
    const path = jobsFile("not-array.mjs", "export default { id: 'x' };\n");
    await assert.rejects(() => loadCronJobs(path), /must default-export an array/);
  });

  it("throws when a job is missing a required field", async () => {
    const path = jobsFile("missing-prompt.mjs",
      "export default [{ id: 'a', schedule: '0 9 * * *' }];\n");
    await assert.rejects(() => loadCronJobs(path), /needs id, schedule, and prompt/);
  });

  // Duplicate ids silently shadow each other in /run_<id> and in the API.
  it("throws on duplicate job ids", async () => {
    const path = jobsFile("dupes.mjs", `
      export default [
        { id: 'a', schedule: '0 9 * * *', prompt: 'one' },
        { id: 'a', schedule: '0 10 * * *', prompt: 'two' },
      ];
    `);
    await assert.rejects(() => loadCronJobs(path), /duplicate job id "a"/);
  });

  it("accepts a jobs module exporting `jobs` instead of a default", async () => {
    const path = jobsFile("named.mjs",
      "export const jobs = [{ id: 'a', schedule: '0 9 * * *', prompt: 'hi' }];\n");
    const jobs = await loadCronJobs(path);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, "a");
  });
});

describe("pickModelForCron", () => {
  it("resolves a job's tier pin", () => {
    assert.equal(pickModelForCron("a-job", "haiku"), "claude-haiku-4-5");
    assert.equal(pickModelForCron("a-job", "fable"), "claude-fable-5");
  });

  it("uses the default tier for a job with no pin", () => {
    assert.equal(pickModelForCron("a-job", null), "claude-sonnet-4-5");
    assert.equal(pickModelForCron("a-job"), "claude-sonnet-4-5");
  });

  it("passes a full model id through", () => {
    assert.equal(
      pickModelForCron("a-job", "claude-sonnet-4-5-20250929"),
      "claude-sonnet-4-5-20250929"
    );
  });

  it("falls back to the default tier for an unrecognized pin", () => {
    assert.equal(pickModelForCron("a-job", "sonnett"), "claude-sonnet-4-5");
  });

  // Agent files and job files share the same vocabulary.
  it("understands Claude Code's own model names", () => {
    assert.equal(pickModelForCron("a-job", "opus"), "claude-fable-5");
    assert.equal(pickModelForCron("a-job", "inherit"), "claude-sonnet-4-5");
  });
});
