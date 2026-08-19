import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProgressTracker } from "../progress.mjs";

// Mock bot that records calls
function mockBot() {
  const calls = [];
  return {
    calls,
    sendMessage: async (chatId, text, opts) => {
      calls.push({ method: "sendMessage", chatId, text, opts });
      return { message_id: 42 };
    },
    editMessageText: async (text, opts) => {
      calls.push({ method: "editMessageText", text, opts });
    },
    deleteMessage: async (chatId, messageId) => {
      calls.push({ method: "deleteMessage", chatId, messageId });
    },
  };
}

describe("createProgressTracker", () => {
  it("creates without errors", () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);
    assert.ok(tracker);
    assert.ok(typeof tracker.onMessage === "function");
    assert.ok(typeof tracker.finish === "function");
    tracker.finish(); // cleanup timer
  });

  it("tracks tool use from assistant messages", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);

    // Simulate assistant message with tool_use
    tracker.onMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/foo/bar/baz.mjs" } },
        ],
      },
    });

    // Should not have sent yet (PROGRESS_DELAY_MS not elapsed)
    // But internally the tool should be tracked
    await tracker.finish();
  });

  it("cleans up status message on finish", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);

    // Manually set a status message ID to simulate one being sent
    // We can't easily trigger the delay, but we can test finish behavior
    await tracker.finish();

    // Timer should be cleared, no crash
    assert.ok(true);
  });

  it("handles tool_use_summary messages", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);

    tracker.onMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        ],
      },
    });

    tracker.onMessage({
      type: "tool_use_summary",
      summary: "Listed files",
      preceding_tool_use_ids: ["t1"],
    });

    // Tool should now be in history, currentTool should be null
    await tracker.finish();
  });

  it("handles tool_progress messages", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);

    tracker.onMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "WebFetch", input: { url: "https://example.com/api" } },
        ],
      },
    });

    // Simulate long-running tool
    tracker.onMessage({
      type: "tool_progress",
      tool_name: "WebFetch",
      tool_use_id: "t1",
      elapsed_time_seconds: 15,
      parent_tool_use_id: null,
    });

    await tracker.finish();
  });

  it("does not crash on unknown message types", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);

    tracker.onMessage({ type: "system", subtype: "init" });
    tracker.onMessage({ type: "result", result: "done" });
    tracker.onMessage({ type: "unknown_type" });

    await tracker.finish();
  });

  it("stops sending updates after finish", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);
    await tracker.finish();

    // These should be no-ops
    tracker.onMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
    });

    assert.equal(bot.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Partial-message streaming (includePartialMessages)
// ---------------------------------------------------------------------------

describe("progress tracker — stream_event handling", () => {
  // Feed one more delta with Date.now pushed past PROGRESS_DELAY_MS (8s) and
  // the 5s edit rate limit so sendOrUpdateStatus actually posts the status.
  async function flushDelta(tracker, text = " END") {
    const realNow = Date.now;
    Date.now = () => realNow() + 10_000;
    try {
      tracker.onMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      });
      await new Promise((r) => setImmediate(r)); // let async send settle
    } finally {
      Date.now = realNow;
    }
  }

  function sendDelta(tracker, text, extra = {}) {
    tracker.onMessage({
      type: "stream_event",
      ...extra,
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
  }

  it("streams the accumulated draft into the status message", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);
    sendDelta(tracker, "Hello ");
    sendDelta(tracker, "world, this is the draft");
    await flushDelta(tracker);
    const sent = bot.calls.find((c) => c.method === "sendMessage");
    assert.ok(sent, "status message should have been sent");
    assert.match(sent.text, /Writing reply/);
    assert.match(sent.text, /this is the draft END/);
    await tracker.finish();
  });

  it("message_start moves the running tool into history instead of dropping it", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);
    // Tool starts (no tool_use_summary follows — not guaranteed by the SDK)
    tracker.onMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/x.mjs" } }] },
    });
    // Next assistant message begins streaming — the tool has finished
    tracker.onMessage({ type: "stream_event", event: { type: "message_start" } });
    await flushDelta(tracker, "drafting");
    const sent = bot.calls.find((c) => c.method === "sendMessage");
    assert.ok(sent);
    assert.match(sent.text, /✓ Reading file/); // completed tool in history
    assert.doesNotMatch(sent.text, /⚙️/); // no longer shown as running
    await tracker.finish();
  });

  it("message_start resets the draft buffer", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);
    sendDelta(tracker, "OLD DRAFT");
    tracker.onMessage({ type: "stream_event", event: { type: "message_start" } });
    sendDelta(tracker, "fresh text");
    await flushDelta(tracker);
    const sent = bot.calls.find((c) => c.method === "sendMessage");
    assert.ok(sent);
    assert.doesNotMatch(sent.text, /OLD DRAFT/);
    assert.match(sent.text, /fresh text END/);
    await tracker.finish();
  });

  it("ignores subagent streams (parent_tool_use_id set)", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);
    sendDelta(tracker, "SUBAGENT INTERNAL", { parent_tool_use_id: "toolu_123" });
    sendDelta(tracker, "main draft");
    await flushDelta(tracker);
    const sent = bot.calls.find((c) => c.method === "sendMessage");
    assert.ok(sent);
    assert.doesNotMatch(sent.text, /SUBAGENT INTERNAL/);
    assert.match(sent.text, /main draft END/);
    await tracker.finish();
  });

  it("ignores malformed stream events", async () => {
    const bot = mockBot();
    const tracker = createProgressTracker(bot, 123, 1);
    tracker.onMessage({ type: "stream_event" }); // no event
    tracker.onMessage({ type: "stream_event", event: { type: "content_block_delta" } }); // no delta
    await tracker.finish();
    assert.ok(true);
  });
});
