/**
 * Progress tracker for long-running Claude queries.
 *
 * Sends periodic status updates to Telegram so the user knows
 * what Claude is doing instead of staring at silence.
 *
 * Features:
 * - Immediate acknowledgement ("On it...")
 * - Tool activity tracking (shows what Claude is doing)
 * - Periodic progress messages (every 30s by default)
 * - Edits a single status message instead of spamming new ones
 */

const TOOL_LABELS = {
  Bash: "Running command",
  Read: "Reading file",
  Write: "Writing file",
  Edit: "Editing file",
  Glob: "Searching files",
  Grep: "Searching code",
  WebFetch: "Fetching URL",
  WebSearch: "Searching the web",
  Agent: "Delegating to agent",
};

// Minimum time before showing progress (don't show for fast queries)
const PROGRESS_DELAY_MS = 8_000;
// How often to update the status message
const UPDATE_INTERVAL_MS = 30_000;

export function createProgressTracker(bot, chatId, replyToMessageId, { log } = {}) {
  let statusMessageId = null;
  let lastUpdateTime = 0;
  let startTime = Date.now();
  let toolHistory = [];       // ordered list of tools used
  let currentTool = null;     // { name, detail, startedAt }
  let turnCount = 0;
  let progressTimer = null;
  let stopped = false;
  let partialText = "";       // streaming assistant text (includePartialMessages)
  const PARTIAL_TAIL_CHARS = 280; // how much of the draft to preview

  function elapsed() {
    const secs = Math.round((Date.now() - startTime) / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  }

  function buildStatusText() {
    const lines = [];

    if (currentTool) {
      const label = TOOL_LABELS[currentTool.name] || currentTool.name;
      const detail = currentTool.detail ? ` — ${currentTool.detail}` : "";
      lines.push(`⚙️ ${label}${detail}`);
    } else if (partialText.trim()) {
      // Live draft preview — show the tail of the reply as it streams
      const tail = partialText.trim().slice(-PARTIAL_TAIL_CHARS);
      lines.push("✍️ Writing reply…");
      lines.push("");
      lines.push(tail.length < partialText.trim().length ? `…${tail}` : tail);
    } else {
      lines.push("🧠 Thinking...");
    }

    // Show recent tool history (last 3)
    const recent = toolHistory.slice(-3);
    if (recent.length > 0) {
      const summary = recent.map((t) => {
        const label = TOOL_LABELS[t.name] || t.name;
        return `✓ ${label}`;
      }).join("\n");
      lines.push("");
      lines.push(summary);
    }

    lines.push("");
    lines.push(`⏱ ${elapsed()} · ${turnCount} turn${turnCount !== 1 ? "s" : ""}`);

    return lines.join("\n");
  }

  async function sendOrUpdateStatus() {
    if (stopped) return;
    // Don't show progress for fast queries
    if (Date.now() - startTime < PROGRESS_DELAY_MS) return;
    // Rate limit updates
    if (Date.now() - lastUpdateTime < 5000) return;

    const text = buildStatusText();
    lastUpdateTime = Date.now();

    try {
      if (statusMessageId) {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: statusMessageId,
        });
      } else {
        const msg = await bot.sendMessage(chatId, text, {
          reply_to_message_id: replyToMessageId,
        });
        statusMessageId = msg.message_id;
      }
    } catch (err) {
      // editMessageText fails if text hasn't changed — that's fine
      if (!err.message?.includes("message is not modified")) {
        if (log) log("warn", "progress-update-failed", { error: err.message });
      }
    }
  }

  // Start periodic updates
  progressTimer = setInterval(() => sendOrUpdateStatus(), UPDATE_INTERVAL_MS);

  return {
    /** Call when an SDK message is received to track progress. */
    onMessage(message) {
      if (stopped) return;

      // Track tool use from assistant messages
      if (message.type === "assistant" && message.message?.content) {
        turnCount++;
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            // Finish previous tool
            if (currentTool) {
              toolHistory.push({ name: currentTool.name, detail: currentTool.detail });
            }
            currentTool = {
              name: block.name,
              detail: extractToolDetail(block.name, block.input),
              startedAt: Date.now(),
            };
            sendOrUpdateStatus();
          }
        }
      }

      // Track tool progress (long-running tools)
      if (message.type === "tool_progress") {
        if (currentTool && message.tool_name === currentTool.name && message.elapsed_time_seconds > 10) {
          sendOrUpdateStatus();
        }
      }

      // Track tool completion via summary
      if (message.type === "tool_use_summary") {
        if (currentTool) {
          toolHistory.push({ name: currentTool.name, detail: currentTool.detail });
          currentTool = null;
        }
        sendOrUpdateStatus();
      }

      // Streaming assistant text (requires includePartialMessages: true).
      // Accumulate text deltas so buildStatusText can preview the draft.
      // sendOrUpdateStatus self-throttles (5s min between edits), so calling
      // it per delta is safe for Telegram's edit rate limits.
      // Subagent streams carry parent_tool_use_id — skip them: their internal
      // drafts are not the reply being written (and could leak sub-agent
      // working text into a group chat's progress message).
      if (message.type === "stream_event" && !message.parent_tool_use_id) {
        const ev = message.event;
        if (ev?.type === "message_start") {
          partialText = "";
          // A new assistant message starting means the previous tool (if any)
          // finished — move it to history rather than dropping it. With
          // partial messages enabled this fires before every assistant
          // message, so it (not the next tool_use block) is what completes
          // tools when the SDK emits no tool_use_summary.
          if (currentTool) {
            toolHistory.push({ name: currentTool.name, detail: currentTool.detail });
            currentTool = null;
          }
        } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          partialText += ev.delta.text;
          // Bound memory: only the preview tail is ever displayed
          if (partialText.length > 4000) partialText = partialText.slice(-4000);
          sendOrUpdateStatus();
        }
      }
    },

    /** Clean up the status message after query completes. */
    async finish() {
      stopped = true;
      if (progressTimer) clearInterval(progressTimer);

      // Delete the progress message — the real response replaces it
      if (statusMessageId) {
        try {
          await bot.deleteMessage(chatId, statusMessageId);
        } catch {
          // Message may already be gone
        }
      }
    },

    /** Get the status message ID (for reference). */
    get messageId() {
      return statusMessageId;
    },
  };
}

/**
 * Extract a human-readable detail from tool input.
 */
function extractToolDetail(toolName, input) {
  if (!input) return null;

  switch (toolName) {
    case "Read":
      return shortPath(input.file_path);
    case "Write":
      return shortPath(input.file_path);
    case "Edit":
      return shortPath(input.file_path);
    case "Bash":
      // Show first 50 chars of command
      return input.command ? truncate(input.command, 50) : null;
    case "Glob":
      return input.pattern || null;
    case "Grep":
      return input.pattern ? `"${truncate(input.pattern, 30)}"` : null;
    case "WebFetch":
      return input.url ? truncate(input.url, 50) : null;
    case "WebSearch":
      return input.query ? `"${truncate(input.query, 40)}"` : null;
    case "Agent":
      return input.description || input.subagent_type || null;
    default:
      return null;
  }
}

function shortPath(p) {
  if (!p) return null;
  // Show last 2 path segments
  const parts = p.split("/");
  return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : p;
}

function truncate(s, max) {
  if (!s) return null;
  s = s.replace(/\n/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
