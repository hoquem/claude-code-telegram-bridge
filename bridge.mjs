import TelegramBot from "node-telegram-bot-api";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "fs";
import { join, resolve as resolvePath } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";
import { execFile } from "child_process";
import { config } from "./config.mjs";
import { agents } from "./agents.mjs";
import { trackCost, auditLog, getDailyCosts } from "./hooks.mjs";
import { startCronScheduler, stopCronScheduler, setCronDeps, listCronJobs, triggerCronJob, hasCronJob } from "./cron-jobs.mjs";
import { setApiDeps, startApiServer } from "./api-server.mjs";
import { SessionStore } from "./session-store.mjs";
import { parseOutboundFiles, sendOutboundFiles, createMediaGroupDebouncer } from "./media.mjs";
import { createProgressTracker } from "./progress.mjs";
import {
  pickModel,
  resolveModelTier,
  fallbackModelFor,
  usedPrimaryModel,
  MODEL_TIERS,
  EFFORT_LEVELS,
} from "./models.mjs";
import {
  nextNetworkErrorStreak,
  POLLING_NETWORK_ERROR_EXIT_THRESHOLD,
  isNetworkClassPollingError,
  isSuppressibleEpipe,
  shouldExitAsZombie,
  ZOMBIE_EPIPE_WATCHDOG_MS,
  PENDING_PROBE_INTERVAL_MS,
} from "./error-classify.mjs";
import {
  querySemaphore,
  RejectionTracker,
  sdkResilienceEnv,
  staleThresholdMs,
  sweepStaleDownloads,
} from "./resilience.mjs";
import { ChatPrefs } from "./chat-prefs.mjs";

// ---------------------------------------------------------------------------
// Validate required config
// ---------------------------------------------------------------------------

if (!config.telegramBotToken) {
  console.error("TELEGRAM_BOT_TOKEN env var is required");
  process.exit(1);
}

if (!existsSync(config.logDir)) {
  mkdirSync(config.logDir, { recursive: true });
}
if (!existsSync(config.stateDir)) {
  mkdirSync(config.stateDir, { recursive: true });
}

// The workspace is where every session runs and where its CLAUDE.md, skills,
// and MCP servers come from. A missing one is not a soft failure: the bridge
// would boot clean, log "All systems online", and then die with an opaque SDK
// error on the first message. Say so now instead.
if (!existsSync(config.cwd)) {
  console.error(
    `CLAUDE_CWD does not exist: ${config.cwd}\n` +
    "Create it and put a CLAUDE.md inside (see CLAUDE.md.example), or point " +
    "CLAUDE_CWD at an existing workspace."
  );
  process.exit(1);
}

// Sweep download files leaked by a crash between download and cleanup.
// Runs once at boot; anything older than 1h in downloadDir is dead weight.
// (log is a hoisted function declaration — safe to call before its definition.)
{
  const sweep = sweepStaleDownloads(config.downloadDir, 60 * 60_000);
  if (sweep.swept > 0 || sweep.errors > 0) {
    log("info", "stale-downloads-swept", sweep);
  }
}

// ---------------------------------------------------------------------------
// Session management (persistent + auto-cleanup)
// ---------------------------------------------------------------------------

const sessionsFile = join(config.stateDir, "sessions.json");
const chatSessions = new SessionStore(sessionsFile, { log });
chatSessions.load();
chatSessions.startCleanupTimer();

// Per-chat model/effort overrides (survive rotation, /reset, and restarts)
const prefsFile = join(config.stateDir, "prefs.json");
const chatPrefs = new ChatPrefs(prefsFile, { log });
chatPrefs.load();

const activeTasks = new Map();  // chatId -> AbortController
const pendingFileMessages = new Map(); // chatId -> { timer, entries: [] }
const FILE_DEBOUNCE_MS = 800; // coalesce rapid file sends

// ---------------------------------------------------------------------------
// Logging (exported for use by cron-jobs.mjs)
// ---------------------------------------------------------------------------

export function log(level, msg, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  console.log(JSON.stringify(entry));

  const today = new Date().toISOString().slice(0, 10);
  const logFile = join(config.logDir, `${today}.jsonl`);
  try {
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Don't throw (logging must never kill the request path), but DO surface
    // the failure to stderr — a silent catch here would hide a full/unwritable
    // log disk and let observability die quietly.
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "log-write-failed", error: err.message, logFile }));
  }
}

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------

const bot = new TelegramBot(config.telegramBotToken, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: { timeout: 50 },
  },
  request: {
    agentOptions: { keepAlive: true, family: 4 },
    timeout: 60000,
  },
});

log("info", "Telegram bridge started", {
  cwd: config.cwd,
  agents: Object.keys(agents).length,
  sessionsRestored: chatSessions.size,
});

// Mark polling as live from the moment bot construction completes (autoStart:true
// means polling begins in the TelegramBot constructor above). Declaring here
// rather than at line ~155 so the watchdog clock starts from confirmed boot,
// not from an arbitrary module-eval timestamp that may be further into setup.
// (In the handshake variant this would be set after startPolling-ok.)
let lastPollSignalAt = Date.now();

// ms epoch of the last EPIPE suppressed by the uncaughtException safety net
// (~line 1140), or null once a poll signal has landed since. Feeds the
// zombie-EPIPE watchdog (~line 1310) — see error-classify.mjs shouldExitAsZombie().
let lastEpipeSuppressedAt = null;

// ---------------------------------------------------------------------------
// Polling error handler — log + alert only; NO in-process restart.
// Recovery path: ntba's own .finally() setTimeout self-heals transient errors.
// If polling truly wedges, the staleness watchdog (~line 1170) and the
// pending-updates watchdog (~line 1213) call process.exit(1) → launchd cold start.
// ---------------------------------------------------------------------------

let consecutivePollingErrors = 0;
const POLLING_ERROR_ALERT_THRESHOLD = 5;

// Sustained network-class errors (EFATAL/ECONNRESET/ETIMEDOUT/ESOCKETTIMEDOUT/
// ECONNREFUSED/ENETUNREACH/ENOTFOUND/EAI_AGAIN/EPIPE — see error-classify.mjs)
// never self-heal within a useful window: 2026-07-05 saw 19 consecutive
// EFATAL over ~24 min (one roughly every 60-75s) before the staleness
// watchdog's 30-min threshold could fire — the outage only ended when the
// external launchd health-check watchdog cut in. Track these separately from
// the generic counter below (409s are deliberately excluded — see the note
// under this handler, they ARE self-healing) and force a clean cold start
// once they run long enough to be clearly wedged rather than a transient
// blip. Classification + threshold live in error-classify.mjs (shared with
// tests). Override with POLLING_NETWORK_ERROR_EXIT_THRESHOLD.
let consecutiveNetworkPollingErrors = 0;

bot.on("polling_error", (err) => {
  consecutivePollingErrors++;
  consecutiveNetworkPollingErrors = nextNetworkErrorStreak(consecutiveNetworkPollingErrors, err);

  log("warn", "polling-error", {
    code: err.code || err.response?.statusCode,
    message: err.message,
    consecutive: consecutivePollingErrors,
    consecutiveNetworkClass: consecutiveNetworkPollingErrors,
  });

  if (consecutivePollingErrors === POLLING_ERROR_ALERT_THRESHOLD && config.heartbeatDeliveryChat) {
    bot.sendMessage(Number(config.heartbeatDeliveryChat),
      `⚠️ Telegram polling has failed ${POLLING_ERROR_ALERT_THRESHOLD} times consecutively. The bot may be deaf.\n\nLatest error: ${err.message}`
    ).catch(() => {});
  }

  // DO NOT call stopPolling/startPolling here. node-telegram-bot-api@0.66.0's
  // stop({cancel:true}) does not set _abort=true, so the original _polling()
  // chain re-schedules itself via setTimeout in .finally(). A subsequent
  // startPolling({restart:true}) then spawns a SECOND concurrent _polling()
  // chain in the same process, and the two chains 409 each other indefinitely.
  // Confirmed in 2026-06-24 logs: every in-process EFATAL recovery produced
  // 600–900 × 409/h until launchd recycled the process; every fresh launchd
  // boot produced near-zero 409s. The library's own setTimeout chain in
  // .finally() self-heals from EFATAL/ECONNRESET on the next interval tick.
  //
  // Instead, once network-class errors have been consecutive for long
  // enough to be clearly wedged (not a transient blip — see threshold above),
  // call process.exit(1) directly. This is the SAME recovery mechanism the
  // staleness watchdog (~line 1170) and pending-updates watchdog (below) already
  // use — a clean launchd cold start — just triggered earlier and more
  // precisely than waiting on those broader timers.
  if (consecutiveNetworkPollingErrors >= POLLING_NETWORK_ERROR_EXIT_THRESHOLD) {
    log("error", "watchdog-polling-network-wedged", {
      code: err.code,
      message: err.message,
      consecutiveNetworkClass: consecutiveNetworkPollingErrors,
    });
    process.exit(1);
  }
});

// Reset counters on successful message receipt; refreshes lastPollSignalAt for watchdog.
// Filter out the bot's own messages (echoed back via can_read_all_group_messages),
// otherwise cron deliveries + heartbeats keep the watchdog asleep even when
// inbound polling is wedged. (lastPollSignalAt declared above at bridge startup.)
bot.on("message", (msg) => {
  if (msg.from?.is_bot) return;
  consecutivePollingErrors = 0;
  consecutiveNetworkPollingErrors = 0;
  lastPollSignalAt = Date.now();
  lastEpipeSuppressedAt = null;
});

// ---------------------------------------------------------------------------
// Media group debouncer — collects multi-photo sends into one prompt
// ---------------------------------------------------------------------------

const mediaGroupDebouncer = createMediaGroupDebouncer(1500, async (chatId, messages) => {
  // Combine all files + captions from the media group
  const files = [];
  let combinedCaption = "";
  for (const m of messages) {
    const fi = getFileFromMessage(m);
    if (fi) {
      try {
        const path = await downloadTelegramFile(fi);
        files.push({ ...fi, localPath: path });
      } catch (err) {
        log("error", "Media group download failed", { chatId, error: err.message });
      }
    }
    if (m.caption && !combinedCaption) combinedCaption = m.caption;
  }

  if (files.length === 0) return;

  const fileNotes = files.map((f, i) =>
    `[File ${i + 1}: ${f.type} — ${f.fileName}${f.mime ? ` (${f.mime})` : ""}]\nSaved to: ${f.localPath}`
  ).join("\n\n");

  const prompt = `[Media group: ${files.length} files attached]\n\n${fileNotes}\n\nUse the Read tool to open and process these files.${combinedCaption ? `\n\n${combinedCaption}` : ""}`;

  log("info", "Media group received", { chatId, fileCount: files.length });

  await bot.sendChatAction(chatId, "typing");
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  try {
    const response = await runClaude(chatId, prompt, messages[0]);
    if (response !== null) {
      const { cleanText, files: outFiles } = parseOutboundFiles(response);
      if (outFiles.length > 0) await sendOutboundFiles(bot, chatId, outFiles);
      if (cleanText) await sendLongMessage(chatId, cleanText, messages[0].message_id);
    }
  } catch (err) {
    log("error", "Media group processing failed", { chatId, error: err.message });
    await bot.sendMessage(chatId, "Failed to process media group.", { reply_to_message_id: messages[0].message_id });
  } finally {
    clearInterval(typingInterval);
    // Cleanup downloaded files
    for (const f of files) {
      if (f.localPath) try { unlinkSync(f.localPath); } catch {}
    }
  }
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

function isAuthorized(msg) {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;

  if (chatType === "private") return config.allowedUsers.has(userId);
  if (chatType === "group" || chatType === "supergroup") {
    return config.allowedGroups.has(chatId) && config.allowedUsers.has(userId);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Send long messages (exported for cron-jobs.mjs)
// ---------------------------------------------------------------------------

// Outbound sensitive-content screen.
//
// Cron results and interactive replies are sent straight through the bot API
// and never pass through the SDK's PreToolUse hooks, so this is the only
// place a "don't say that in a group chat" rule can be enforced. A message
// bound for anywhere other than SENSITIVE_REDIRECT_CHAT that matches one of
// SENSITIVE_KEYWORDS on a word boundary is redirected there instead, with a
// note saying where it was headed.
//
// Choose keywords that are specific. A word that shows up in ordinary
// conversation will redirect messages you wanted in the group.
const SENSITIVE_RE = config.sensitiveKeywords.length > 0
  ? new RegExp(`\\b(${config.sensitiveKeywords.map(escapeRegExp).join("|")})\\b`, "i")
  : null;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sensitiveScreen(chatId, text) {
  if (!SENSITIVE_RE) return null;
  if (String(chatId) === String(config.sensitiveRedirectChat)) return null;
  const m = (text || "").match(SENSITIVE_RE);
  return m ? m[0] : null;
}

export async function sendLongMessage(chatId, text, replyToMessageId) {
  if (!text || text.trim().length === 0) text = "(No response generated)";

  const sensitiveHit = sensitiveScreen(chatId, text);
  if (sensitiveHit) {
    log("warn", "sensitive-redirect", { chatId, keyword: sensitiveHit, textLen: text.length });
    auditLog("sensitive-redirect", { chatId, keyword: sensitiveHit });
    text = `⚠️ *Redirected* — this message was headed for chat ${chatId} but mentions "${sensitiveHit}", so it was delivered here instead.\n\n${text}`;
    chatId = Number(config.sensitiveRedirectChat);
    replyToMessageId = undefined;
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= config.maxResponseLength) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", config.maxResponseLength);
    if (splitIdx < config.maxResponseLength * 0.5) splitIdx = config.maxResponseLength;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  let lastMsg;
  for (const chunk of chunks) {
    try {
      lastMsg = await bot.sendMessage(chatId, chunk, {
        reply_to_message_id: replyToMessageId,
        parse_mode: "Markdown",
      });
    } catch {
      lastMsg = await bot.sendMessage(chatId, chunk, {
        reply_to_message_id: replyToMessageId,
      });
    }
    replyToMessageId = undefined;
  }
  return lastMsg;
}

// ---------------------------------------------------------------------------
// Shared tools and query options
// ---------------------------------------------------------------------------

const ALL_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"];

// querySemaphore (imported from resilience.mjs, MAX_CONCURRENT_QUERIES=3):
// every SDK query() call site — interactive runClaude here, the heartbeat
// below, and cron-jobs.mjs — acquires a slot before spawning a subprocess.
// Each subprocess holds ~300 MB; uncapped, a cron burst plus a busy evening
// across several group chats can push the host into swap. Queued queries wait FIFO; the
// user keeps seeing "typing" while queued.

// Wall-clock cap on a single interactive query. maxTurns alone doesn't bound
// time — a stuck tool can hold a chat slot indefinitely and recovery used to
// depend entirely on the orphan reaper. 30 min default leaves deep-research
// runs room; override with RUNCLAUDE_TIMEOUT_MS.
const RUNCLAUDE_TIMEOUT_MS = Number(process.env.RUNCLAUDE_TIMEOUT_MS) || 30 * 60_000;

// ---------------------------------------------------------------------------
// Run Claude Code for a user message
// ---------------------------------------------------------------------------

async function runClaude(chatId, prompt, contextMsg, { showProgress = true, isRetry = false, modelOverride = null } = {}) {
  // --- Pre-query rotation check ---
  if (!isRetry && chatSessions.needsRotation(chatId)) {
    chatSessions.rotate(chatId);
  }

  const sessionInfo = chatSessions.get(chatId);
  const abortController = new AbortController();

  if (activeTasks.has(chatId)) activeTasks.get(chatId).abort();
  activeTasks.set(chatId, abortController);

  const options = {
    cwd: config.cwd,
    // BRIDGE_DELIVER_TO names the chat this reply goes back to, so hooks in
    // the workspace can make destination-aware decisions.
    // sdkResilienceEnv: stream watchdog + transport retries, so a wedged
    // SSE stream inside the SDK subprocess self-terminates instead of
    // hanging the query until the orphan reaper notices.
    env: { ...process.env, ...sdkResilienceEnv(), BRIDGE_DELIVER_TO: String(chatId) },
    abortController,
    allowedTools: ALL_TOOLS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Generous by design: a 25-turn cap was killing long research and
    // multi-file builds mid-flight. The wall-clock timeout below is the real
    // bound on a runaway query.
    maxTurns: Number(process.env.MAX_TURNS) || 100,
    persistSession: true,
    agents, // subagents available for delegation
    // Full Claude Code system prompt + filesystem settings: loads the
    // CLAUDE.md in cwd, plus user/project skills and MCP servers — sessions
    // get the same capabilities as the claude CLI. Keep this across SDK
    // upgrades; it is what makes the bot behave like Claude Code and not
    // like a bare API client.
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project"],
    // Stream partial assistant text so the progress message can show the
    // reply being drafted instead of a bare "Thinking..." for minutes.
    includePartialMessages: true,
    stderr: (chunk) => log("error", "claude-stderr", { source: "user-query", chatId, chunk: String(chunk).trim() }),
  };

  if (sessionInfo?.sessionId) options.resume = sessionInfo.sessionId;

  const contextPrefix = contextMsg
    ? `[Telegram from ${contextMsg.from?.first_name || "user"} in ${contextMsg.chat.title || "DM"} (chat ${chatId})]\n\n`
    : "";

  // Model precedence: ANTHROPIC_MODEL_FORCE (kill switch) → caller override
  // (internal, e.g. /compact) → this chat's /model pin → default tier.
  // Subagents are not routed here; each one carries its own model from its
  // definition file.
  const prefs = chatPrefs.get(chatId);
  const model = pickModel(
    modelOverride || prefs.model,
    `chat ${chatId}`,
    (msg) => log("warn", "model-unrecognized", { chatId, message: msg })
  );
  options.model = model;
  // Fallback: if the primary model errors (overload/outage), the SDK retries
  // on the adjacent tier instead of failing the message. Never set when the
  // ANTHROPIC_MODEL_FORCE kill switch is active — its contract is "ALL
  // traffic on exactly this model", and a silent fallback would break the
  // rollback path precisely when the operator is relying on it.
  if (!config.modelForce) options.fallbackModel = fallbackModelFor(model, config);
  if (prefs.effort) options.effort = prefs.effort;

  // Progress tracker — shows tool activity in Telegram
  const progress = showProgress
    ? createProgressTracker(bot, chatId, contextMsg?.message_id, { log })
    : null;

  let resultText = "";
  let newSessionId = sessionInfo?.sessionId;
  let totalCost = 0;
  let totalTurns = 0;
  let timedOut = false;

  // Concurrency gate — wait for a subprocess slot. If the user cancelled
  // (or a newer message replaced us) while queued, skip the query entirely.
  if (querySemaphore.queued > 0 || querySemaphore.active >= querySemaphore.max) {
    log("info", "query-queued", { chatId, active: querySemaphore.active, queued: querySemaphore.queued });
  }
  await querySemaphore.acquire();

  // Wall-clock cap — a stuck query can otherwise hold the chat slot (and a
  // semaphore slot) indefinitely; maxTurns bounds turns, not time.
  const wallClockTimer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, RUNCLAUDE_TIMEOUT_MS);

  try {
    if (abortController.signal.aborted) {
      log("info", "query-abandoned-while-queued", { chatId });
      return null;
    }
    for await (const message of query({ prompt: contextPrefix + prompt, options })) {
      if (abortController.signal.aborted) break;

      // Feed messages to progress tracker
      if (progress) progress.onMessage(message);

      if (message.type === "system" && message.subtype === "init") {
        newSessionId = message.session_id;
      }

      // Fallback engagement must never be silent (P-rule: no fallbacks that
      // hide issues) — surface the swap in the structured log the moment the
      // SDK reports it.
      if (message.type === "system" && message.subtype === "model_refusal_fallback") {
        log("warn", "model-fallback-engaged", {
          chatId,
          from: message.original_model || model,
          to: message.fallback_model,
          category: message.api_refusal_category ?? null,
        });
      }

      if (message.type === "result") {
        // SDK sometimes emits result multiple times; only track cost on first
        const isFirstResult = !resultText && !totalCost;
        resultText = message.result || "";
        if (isFirstResult) {
          totalCost = message.total_cost_usd || 0;
          totalTurns = message.num_turns || 0;
          // modelUsage records what actually ran (primary, fallback, and any
          // subagent models) — logged so a served-by-fallback turn is visible
          // in the audit trail even without a refusal-fallback system message.
          const modelsUsed = Object.keys(message.modelUsage || {});
          if (modelsUsed.length > 0 && !usedPrimaryModel(model, modelsUsed)) {
            log("warn", "primary-model-not-used", { chatId, routed: model, modelsUsed });
          }
          trackCost("user-message", totalCost, { chatId, model, modelsUsed });
          log("info", "Claude response", {
            chatId, sessionId: newSessionId,
            turns: totalTurns, cost: totalCost,
            costPerTurn: totalTurns > 0 ? +(totalCost / totalTurns).toFixed(4) : 0,
            duration_ms: message.duration_ms,
            model,
            modelsUsed,
          });
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      if (!timedOut) {
        log("info", "Query aborted", { chatId });
        return null;
      }
      // Timed out — the post-loop block below logs and builds the user message.
    } else {
      log("error", "Claude query failed", { chatId, error: err.message });
      resultText = `Error: ${err.message}`;
    }
  } finally {
    clearTimeout(wallClockTimer);
    querySemaphore.release();
    // Only remove our slot if it still holds THIS controller. A newer message
    // for the same chat may have already replaced us (line ~258 aborts+sets);
    // an unconditional delete would drop the new task's controller and break
    // /cancel, /reset, shutdown-abort, and the orphan-reaper's liveness check.
    if (activeTasks.get(chatId) === abortController) activeTasks.delete(chatId);
    if (progress) await progress.finish();
  }

  // Single timeout-reporting site — reached whether the abort surfaced as an
  // AbortError throw or as a signal-aborted loop break.
  if (timedOut && !resultText) {
    log("error", "Query wall-clock timeout", { chatId, timeoutMs: RUNCLAUDE_TIMEOUT_MS });
    resultText = `⏱️ Query timed out after ${Math.round(RUNCLAUDE_TIMEOUT_MS / 60000)} min. Partial work may have completed — try again or /reset for a fresh session.`;
  }

  // --- Post-query: detect bloated session (empty response + high cost) ---
  const costPerTurn = totalTurns > 0 ? totalCost / totalTurns : totalCost;
  if (!isRetry && !resultText && costPerTurn > 0.50) {
    log("warn", "session-bloat-detected", {
      chatId, sessionId: newSessionId,
      costPerTurn: +costPerTurn.toFixed(4), resultLen: 0,
    });
    chatSessions.rotate(chatId);
    // Retry once with a fresh session — keep the caller's model pin.
    return runClaude(chatId, prompt, contextMsg, { showProgress, isRetry: true, modelOverride });
  }

  // Update session with message count tracking
  const existing = chatSessions.get(chatId);
  chatSessions.set(chatId, {
    sessionId: newSessionId,
    lastActivity: Date.now(),
    messageCount: (existing?.messageCount || 0) + 1,
  });

  // Check if next query should rotate (based on cost-per-turn trend)
  if (costPerTurn > 0.50) {
    chatSessions.needsRotation(chatId, costPerTurn);
  }

  // Silence signals (NO_REPLY, HEARTBEAT_OK, etc.) — return null so caller skips the Telegram send
  if (resultText && isHeartbeatOk(resultText)) {
    log("info", "silence-signal-suppressed", { chatId, firstLine: resultText.trim().split("\n")[0].trim() });
    return null;
  }

  return resultText;
}

// ---------------------------------------------------------------------------
// File / media handling
// ---------------------------------------------------------------------------

function getFileFromMessage(msg) {
  if (msg.document) {
    return { fileId: msg.document.file_id, fileName: msg.document.file_name || "document", type: "document", mime: msg.document.mime_type };
  }
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]; // largest resolution
    return { fileId: photo.file_id, fileName: `photo_${photo.file_unique_id}.jpg`, type: "photo", mime: "image/jpeg" };
  }
  if (msg.video) {
    return { fileId: msg.video.file_id, fileName: msg.video.file_name || `video_${msg.video.file_unique_id}.mp4`, type: "video", mime: msg.video.mime_type };
  }
  if (msg.audio) {
    return { fileId: msg.audio.file_id, fileName: msg.audio.file_name || `audio_${msg.audio.file_unique_id}.mp3`, type: "audio", mime: msg.audio.mime_type };
  }
  if (msg.voice) {
    return { fileId: msg.voice.file_id, fileName: `voice_${msg.voice.file_unique_id}.ogg`, type: "voice", mime: msg.voice.mime_type };
  }
  if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) {
    return { fileId: msg.sticker.file_id, fileName: `sticker_${msg.sticker.file_unique_id}.webp`, type: "sticker", mime: "image/webp" };
  }
  return null;
}

async function downloadTelegramFile(fileInfo) {
  if (!existsSync(config.downloadDir)) mkdirSync(config.downloadDir, { recursive: true });

  // bot.downloadFile returns the local path (downloadDir + serverFileName)
  const downloadedPath = await bot.downloadFile(fileInfo.fileId, config.downloadDir);

  // Rename to the original filename for clarity (e.g. "statement.pdf" instead of "file_123.pdf")
  const targetPath = join(config.downloadDir, fileInfo.fileName);
  if (downloadedPath !== targetPath) {
    try { renameSync(downloadedPath, targetPath); } catch { return downloadedPath; }
  }
  return targetPath;
}

// ---------------------------------------------------------------------------
// Voice message transcription (ffmpeg + local whisper)
// ---------------------------------------------------------------------------

// Voice notes are transcribed locally, so audio never leaves the host.
// Both binaries are optional: without them a voice message is handed to
// Claude as a file rather than a transcript.
const FFMPEG_PATH = config.ffmpegPath;
const WHISPER_PATH = config.whisperPath;

// Service managers (launchd, systemd) give a process a minimal PATH, so a
// Homebrew or pipx install is invisible unless EXTRA_PATH names its bin dir.
const CHILD_PATH = config.extraPath
  ? `${config.extraPath}:${process.env.PATH}`
  : process.env.PATH;

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, env: { ...process.env, PATH: CHILD_PATH } }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function transcribeVoice(oggPath) {
  const wavPath = oggPath.replace(/\.ogg$/, ".wav");
  const txtPath = oggPath.replace(/\.ogg$/, ".txt");
  const outDir = join(oggPath, "..");
  const baseName = oggPath.replace(/\.ogg$/, "").split("/").pop();

  try {
    // Step 1: Convert OGG/Opus → WAV (16kHz mono for Whisper).
    // Timeout: a hung ffmpeg (corrupt input, codec stall) must not block the
    // file-message handler indefinitely — voice notes convert in <2s normally.
    await execFileAsync(FFMPEG_PATH, ["-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath, "-y"], { timeout: 60000 });

    // Step 2: Transcribe with local Whisper
    await execFileAsync(WHISPER_PATH, [wavPath, "--model", config.whisperModel, "--language", config.whisperLanguage, "--output_format", "txt", "--output_dir", outDir], { timeout: 60000 });

    // Step 3: Read transcript
    const transcript = readFileSync(txtPath, "utf-8").trim();

    // Cleanup temp files (WAV, TXT, and original OGG)
    try { unlinkSync(wavPath); } catch {}
    try { unlinkSync(txtPath); } catch {}
    try { unlinkSync(oggPath); } catch {}

    return transcript || null;
  } catch (err) {
    log("error", "Voice transcription failed", { oggPath, error: err.message });
    // Cleanup on failure
    try { unlinkSync(wavPath); } catch {}
    try { unlinkSync(txtPath); } catch {}
    return null;
  }
}

// ---------------------------------------------------------------------------
// Debounced file handler — coalesces rapid photo/file sends into one prompt
// ---------------------------------------------------------------------------

async function handleDebouncedFiles(chatId, entries) {
  const firstMsg = entries[0].msg;
  const filePaths = [];

  // Build prompt from all collected files
  const parts = [];
  let combinedCaption = "";

  for (const entry of entries) {
    const { fileInfo, filePath, caption } = entry;
    filePaths.push(filePath);

    if (fileInfo.type === "voice") {
      log("info", "Transcribing voice message", { chatId, filePath });
      const transcript = await transcribeVoice(filePath);
      if (transcript) {
        log("info", "Voice transcription complete", { chatId, transcriptLen: transcript.length });
        parts.push(`[Voice message transcribed]\nTranscript: ${transcript}`);
      } else {
        parts.push(`[Attached ${fileInfo.type}: ${fileInfo.fileName} (${fileInfo.mime})]\nFile saved to: ${filePath}\nVoice transcription failed. Use the Read tool to open and process this file.`);
      }
    } else {
      parts.push(`[Attached ${fileInfo.type}: ${fileInfo.fileName}${fileInfo.mime ? ` (${fileInfo.mime})` : ""}]\nFile saved to: ${filePath}\nUse the Read tool to open and process this file.`);
    }
    if (caption && !combinedCaption) combinedCaption = caption;
  }

  const prompt = parts.join("\n\n") + (combinedCaption ? `\n\n${combinedCaption}` : "");
  if (!prompt.trim()) return;

  log("info", "Incoming message", {
    chatId, userId: firstMsg.from?.id, username: firstMsg.from?.username,
    textLen: combinedCaption.length, hasFile: true, fileCount: entries.length,
  });

  await bot.sendChatAction(chatId, "typing");
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  try {
    const response = await runClaude(chatId, prompt, firstMsg);
    if (response !== null) {
      const { cleanText, files } = parseOutboundFiles(response);
      if (files.length > 0) {
        const results = await sendOutboundFiles(bot, chatId, files);
        log("info", "Outbound files sent", { chatId, results });
      }
      if (cleanText) await sendLongMessage(chatId, cleanText, firstMsg.message_id);
    }
  } catch (err) {
    log("error", "File message processing failed", { chatId, error: err.message });
    await bot.sendMessage(chatId, "Something went wrong processing files. Check logs.", {
      reply_to_message_id: firstMsg.message_id,
    });
  } finally {
    clearInterval(typingInterval);
    // Cleanup downloaded files (voice files already cleaned by transcribeVoice)
    for (const fp of filePaths) {
      try { unlinkSync(fp); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

bot.on("message", async (msg) => {
  const text = msg.text || msg.caption || "";
  const fileInfo = getFileFromMessage(msg);

  // Skip if no text AND no file (e.g. service messages, animations)
  if (!text && !fileInfo) return;
  // Skip commands (handled by onText handlers)
  if (text.startsWith("/")) return;

  if (!isAuthorized(msg)) {
    log("warn", "Unauthorized", { userId: msg.from?.id, chatId: msg.chat.id });
    return;
  }

  // Media group debouncing — collect multi-photo sends
  if (msg.media_group_id) {
    mediaGroupDebouncer.add(msg);
    return;
  }

  const chatId = msg.chat.id;

  // --- File messages: download then debounce to coalesce rapid sends ---
  if (fileInfo) {
    let filePath = null;
    try {
      filePath = await downloadTelegramFile(fileInfo);
      log("info", "File downloaded", {
        chatId, type: fileInfo.type, fileName: fileInfo.fileName, mime: fileInfo.mime, localPath: filePath,
      });
    } catch (err) {
      log("error", "File download failed", { chatId, error: err.message });
      await bot.sendMessage(chatId, `Failed to download ${fileInfo.type}: ${err.message}`, {
        reply_to_message_id: msg.message_id,
      });
      return;
    }

    // Debounce: collect rapid file messages before calling runClaude
    // This prevents photo 2 aborting photo 1's query when sent in quick succession
    if (!pendingFileMessages.has(chatId)) {
      pendingFileMessages.set(chatId, { timer: null, entries: [] });
    }
    const pending = pendingFileMessages.get(chatId);
    clearTimeout(pending.timer);
    pending.entries.push({ msg, fileInfo, filePath, caption: text });

    pending.timer = setTimeout(() => {
      const entries = pending.entries;
      pendingFileMessages.delete(chatId);
      handleDebouncedFiles(chatId, entries);
    }, FILE_DEBOUNCE_MS);
    return;
  }

  // --- Text-only messages: process immediately ---
  if (!text.trim()) return;

  log("info", "Incoming message", {
    chatId, userId: msg.from?.id, username: msg.from?.username,
    textLen: text.length, hasFile: false,
  });

  await bot.sendChatAction(chatId, "typing");
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  try {
    const response = await runClaude(chatId, text, msg);
    if (response !== null) {
      const { cleanText, files } = parseOutboundFiles(response);
      if (files.length > 0) {
        const results = await sendOutboundFiles(bot, chatId, files);
        log("info", "Outbound files sent", { chatId, results });
      }
      if (cleanText) await sendLongMessage(chatId, cleanText, msg.message_id);
    }
  } catch (err) {
    log("error", "Message processing failed", { chatId, error: err.message });
    await bot.sendMessage(chatId, "Something went wrong. Check logs.", {
      reply_to_message_id: msg.message_id,
    });
  } finally {
    clearInterval(typingInterval);
  }
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg)) return;
  bot.sendMessage(msg.chat.id, `${config.assistantName} (Claude Code) is online. Send me a message.`);
});

bot.onText(/\/help/, (msg) => {
  if (!isAuthorized(msg)) return;
  bot.sendMessage(msg.chat.id, [
    `*${config.assistantName} — Claude Code Bridge*`,
    "",
    "/start — Check bot is alive",
    "/help — This message",
    "/reset — Start a fresh conversation",
    "/cancel — Cancel the in-flight query",
    "/status — Show session & cost info",
    "/model — Show/set model for this chat (fable/sonnet/haiku/auto)",
    "/effort — Show/set effort for this chat (low→max/auto)",
    "/compact — Compact the session context (keeps the conversation going)",
    "/heartbeat — Run heartbeat checks now",
    "/cron — List cron jobs",
    "/run\\_JOB\\_ID — Trigger a cron job manually",
    "/costs — Show daily cost summary",
    "",
    "Just send a message to chat with Claude.",
    Object.keys(agents).length > 0 ? `Agents: ${Object.keys(agents).join(", ")}` : null,
  ].filter(Boolean).join("\n"), { parse_mode: "Markdown" });
});

bot.onText(/\/reset/, (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  if (activeTasks.has(chatId)) activeTasks.get(chatId).abort();
  chatSessions.delete(chatId);
  bot.sendMessage(chatId, "Session reset. Starting fresh.");
  log("info", "Session reset", { chatId });
});

bot.onText(/\/cancel/, (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  if (activeTasks.has(chatId)) {
    activeTasks.get(chatId).abort();
    bot.sendMessage(chatId, "Cancelled in-flight query.");
    log("info", "User cancelled query", { chatId });
  } else {
    bot.sendMessage(chatId, "No active query to cancel.");
  }
});

// /model [fable|sonnet|haiku|auto] — per-chat model pin. Persists across
// restarts and session rotation; "auto" clears it back to the default tier.
bot.onText(/^\/model(?:@\w+)?(?:\s+(.+?))?\s*$/, (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const arg = match[1]?.trim().toLowerCase();
  if (!arg) {
    const prefs = chatPrefs.get(chatId);
    const current = prefs.model || "auto";
    const resolved = resolveModelTier(prefs.model, config);
    bot.sendMessage(chatId, [
      `*Model for this chat:* ${current}${resolved ? ` (\`${resolved}\`)` : ` (default tier: ${config.defaultModelTier})`}`,
      config.modelForce ? `⚠️ ANTHROPIC\\_MODEL\\_FORCE is set (\`${config.modelForce}\`) — it overrides everything.` : null,
      "",
      "Set with: /model fable | sonnet | haiku | auto",
    ].filter(Boolean).join("\n"), { parse_mode: "Markdown" });
    return;
  }
  if (!MODEL_TIERS.includes(arg)) {
    bot.sendMessage(chatId, `Unknown tier "${arg}". Use: ${MODEL_TIERS.join(" | ")}`);
    return;
  }
  chatPrefs.set(chatId, { model: arg === "auto" ? null : arg });
  log("info", "chat-model-override", { chatId, model: arg });
  bot.sendMessage(chatId, arg === "auto"
    ? `Model pin cleared — back to the default tier (${config.defaultModelTier}).`
    : `Model for this chat pinned to *${arg}* (\`${resolveModelTier(arg, config)}\`).`,
    { parse_mode: "Markdown" });
});

// /effort [low|medium|high|xhigh|max|auto] — per-chat reasoning-effort override.
bot.onText(/^\/effort(?:@\w+)?(?:\s+(.+?))?\s*$/, (msg, match) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const arg = match[1]?.trim().toLowerCase();
  if (!arg) {
    const prefs = chatPrefs.get(chatId);
    bot.sendMessage(chatId, [
      `*Effort for this chat:* ${prefs.effort || "auto (model default)"}`,
      "",
      "Set with: /effort low | medium | high | xhigh | max | auto",
    ].join("\n"), { parse_mode: "Markdown" });
    return;
  }
  if (!EFFORT_LEVELS.includes(arg)) {
    bot.sendMessage(chatId, `Unknown effort "${arg}". Use: ${EFFORT_LEVELS.join(" | ")}`);
    return;
  }
  chatPrefs.set(chatId, { effort: arg === "auto" ? null : arg });
  log("info", "chat-effort-override", { chatId, effort: arg });
  bot.sendMessage(chatId, arg === "auto"
    ? "Effort restored to model default."
    : `Effort for this chat set to *${arg}*.`, { parse_mode: "Markdown" });
});

// /compact — run the CLI's /compact slash command inside the chat's session,
// summarizing old context so the conversation can continue without rotation.
bot.onText(/^\/compact(?:@\w+)?\s*$/, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const session = chatSessions.get(chatId);
  if (!session?.sessionId) {
    bot.sendMessage(chatId, "No session to compact — start a conversation first.");
    return;
  }
  // runClaude aborts any in-flight query for the chat when it starts — don't
  // let /compact silently kill a running task whose answer would then never
  // arrive. Queue discipline is the user's: finish or /cancel first.
  if (activeTasks.has(chatId)) {
    bot.sendMessage(chatId, "A query is currently running — wait for it to finish (or /cancel it) before compacting.");
    return;
  }
  bot.sendMessage(chatId, "Compacting session context…");
  // contextMsg deliberately null: runClaude prepends a "[Telegram from …]"
  // prefix for real messages, which would turn "/compact" into plain text
  // instead of a slash command.
  // Pinned to sonnet: summarizing a context-heavy session is real work, and
  // the chat's own pin may be haiku.
  const response = await runClaude(chatId, "/compact", null, { showProgress: false, modelOverride: "sonnet" });
  // null = the query never completed (aborted by /cancel, replaced by a newer
  // message, or suppressed) — compaction did NOT happen; don't claim it did
  // and don't reset the rotation counter.
  if (response === null) {
    bot.sendMessage(chatId, "Compact aborted before it finished — session unchanged.");
    log("warn", "session-compact-aborted", { chatId });
    return;
  }
  if (/^(⏱️|Error:)/.test(response)) {
    bot.sendMessage(chatId, `Compact failed: ${response}`);
    log("warn", "session-compact-failed", { chatId, error: response.slice(0, 200) });
    return;
  }
  // Compaction shrinks the live context — reset the rotation counter so the
  // conversation the user just compacted isn't rotated away on the next
  // message anyway. (runClaude's own set() just incremented it.)
  const after = chatSessions.get(chatId);
  if (after) chatSessions.set(chatId, { ...after, messageCount: 0 });
  bot.sendMessage(chatId, "Session compacted — context summarized, conversation continues.");
  log("info", "session-compacted", { chatId });
});

// Manual trigger. Bypasses the probe pre-filter and quiet hours, but the
// other skip reasons still apply — so report what actually happened rather
// than "complete" regardless. The report itself goes to
// HEARTBEAT_DELIVERY_CHAT, which may not be this chat.
const HEARTBEAT_SKIP_MESSAGES = {
  "not-configured": "Heartbeat is not configured — set HEARTBEAT_PROMPT_FILE to a file describing what to check.",
  "prompt-file-unreadable": "Heartbeat prompt file could not be read — check HEARTBEAT_PROMPT_FILE and the logs.",
  "already-running": "A heartbeat is already running — try again shortly.",
  "semaphore-busy": "No query slot free for the heartbeat — the bridge is busy. Try again shortly.",
};

bot.onText(/\/heartbeat/, async (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  if (!config.heartbeatPromptFile) {
    bot.sendMessage(chatId, HEARTBEAT_SKIP_MESSAGES["not-configured"]);
    return;
  }
  bot.sendMessage(chatId, "Running heartbeat now...");
  const outcome = await runHeartbeat({ force: true });

  if (!outcome?.ran) {
    bot.sendMessage(chatId, HEARTBEAT_SKIP_MESSAGES[outcome?.reason] || `Heartbeat did not run (${outcome?.reason || "unknown"}).`);
    return;
  }
  if (outcome.error) {
    bot.sendMessage(chatId, outcome.timedOut ? "Heartbeat timed out — checks may be incomplete." : `Heartbeat failed: ${outcome.error}`);
    return;
  }
  const sameChat = String(chatId) === String(config.heartbeatDeliveryChat);
  if (outcome.delivered) {
    bot.sendMessage(chatId, sameChat ? "Heartbeat complete." : `Heartbeat complete — report sent to chat ${config.heartbeatDeliveryChat}.`);
  } else {
    bot.sendMessage(chatId, "Heartbeat complete — nothing to report.");
  }
});

bot.onText(/\/status/, (msg) => {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const session = chatSessions.get(chatId);
  const isActive = activeTasks.has(chatId);
  const costs = getDailyCosts();
  const prefs = chatPrefs.get(chatId);

  bot.sendMessage(chatId, [
    `*Session:* ${session?.sessionId?.slice(0, 8) || "none"}...`,
    `*Messages:* ${session?.messageCount || 0} / ${chatSessions.maxMessages}`,
    `*Active task:* ${isActive ? "yes" : "no"}`,
    `*Model:* ${prefs.model || "auto"} · *Effort:* ${prefs.effort || "auto"}`,
    `*Query slots:* ${querySemaphore.active}/${querySemaphore.max} active, ${querySemaphore.queued} queued`,
    `*Last activity:* ${session?.lastActivity ? new Date(session.lastActivity).toISOString() : "never"}`,
    `*Daily cost:* $${costs.total.toFixed(4)} (${costs.queries} queries)`,
    `*CWD:* \`${config.cwd}\``,
    `*Agents:* ${Object.keys(agents).join(", ")}`,
  ].join("\n"), { parse_mode: "Markdown" });
});

bot.onText(/\/costs/, (msg) => {
  if (!isAuthorized(msg)) return;
  const costs = getDailyCosts();
  const lines = [
    `*Daily Cost Summary (${costs.date || "today"})*`,
    `Total: $${costs.total.toFixed(4)}`,
    `Queries: ${costs.queries}`,
    "",
    "*By type:*",
  ];
  for (const [type, amount] of Object.entries(costs.byType || {})) {
    lines.push(`  ${type}: $${amount.toFixed(4)}`);
  }
  if (Object.keys(costs.byModel || {}).length > 0) {
    lines.push("", "*By model:*");
    for (const [model, amount] of Object.entries(costs.byModel)) {
      lines.push(`  ${model}: $${amount.toFixed(4)}`);
    }
  }
  bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
});

bot.onText(/\/cron/, async (msg) => {
  if (!isAuthorized(msg)) return;
  const jobs = listCronJobs();
  const lines = ["*Cron Jobs*", ""];
  for (const j of jobs) {
    const status = j.running ? "🔄" : "⏱️";
    const target = j.deliverTo ? ` → ${j.deliverTo}` : "";
    lines.push(`${status} \`${j.id}\` — ${j.schedule}${target}`);
  }
  lines.push("", "_Use /run\\_JOB\\_ID to trigger manually_");
  bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
});

bot.onText(/\/run_(.+)/, async (msg, match) => {
  if (!isAuthorized(msg)) return;
  const jobId = match[1];
  bot.sendMessage(msg.chat.id, `Triggering cron job: ${jobId}...`);
  const result = await triggerCronJob(jobId);
  if (result === null) {
    bot.sendMessage(msg.chat.id, `Job not found: ${jobId}`);
  } else {
    bot.sendMessage(msg.chat.id, `Job ${jobId} completed.`);
  }
});

// ---------------------------------------------------------------------------
// Heartbeat system
// ---------------------------------------------------------------------------

const HEARTBEAT_OK_PATTERNS = [
  /^heartbeat[_ ]?ok$/i, /^no[_ ]?reply$/i, /^no[_ ]?action/i,
  /^nothing[_ ]?to[_ ]?report/i, /^all[_ ]?clear/i, /^no[_ ]?alerts?/i,
];

// Single source for "what hour is it" in the configured timezone — used by
// the quiet-hours check, the staleness watchdog, and the getMe probe, so all
// time-of-day logic agrees and none of it depends on the host's local zone.
function hourInConfigTz() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: config.timezone })).getHours();
}

function isQuietHours() {
  const hour = hourInConfigTz();
  if (config.quietStart > config.quietEnd) {
    return hour >= config.quietStart || hour < config.quietEnd;
  }
  return hour >= config.quietStart && hour < config.quietEnd;
}

function isHeartbeatOk(text) {
  if (!text || text.trim().length === 0) return true;
  const firstLine = text.trim().split("\n")[0].trim();
  return HEARTBEAT_OK_PATTERNS.some((p) => p.test(firstLine));
}

/**
 * Build the heartbeat prompt.
 *
 * The checklist itself is yours: HEARTBEAT_PROMPT_FILE names a file
 * describing what to check and how to report it. The bridge prepends the
 * current time and appends the reporting contract the suppression logic
 * depends on — a run with nothing to say must answer HEARTBEAT_OK, or every
 * quiet tick becomes a notification.
 *
 * :returns: The prompt, or ``null`` when no prompt file is configured.
 */
export function buildHeartbeatPrompt() {
  if (!config.heartbeatPromptFile) return null;

  let checklist;
  const promptPath = resolvePath(config.heartbeatPromptFile.replace(/^~(?=\/|$)/, homedir()));
  try {
    checklist = readFileSync(promptPath, "utf-8").trim();
  } catch (err) {
    log("error", "heartbeat-prompt-unreadable", {
      file: promptPath,
      error: err.message,
    });
    return null;
  }

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: config.timezone }));

  return `You are running a scheduled heartbeat check. Time: ${now.toLocaleString("en-GB", { timeZone: config.timezone })} (${config.timezone}).

${checklist}

RULES:
- GRACEFUL DEGRADATION: run each check independently. If one fails (API timeout, network error), note the failure and CONTINUE with the rest. Do not abandon the heartbeat because one source is down.
- If any check failed, end with a "⚠️ Degraded" section naming which and why.
- If nothing needs attention and nothing failed: reply with exactly HEARTBEAT_OK and nothing else.
- Otherwise: a concise alert with bold headers. This goes to a chat app — no tables.`;
}

let heartbeatTimer = null;
let heartbeatRunning = false;

// --- Deterministic pre-filter ---
// An LLM heartbeat on a short interval is the easiest way to run up a bill on
// a system that is mostly idle. When HEARTBEAT_PROBE_URL is set, each tick
// hashes that endpoint first and skips the model entirely while the hash is
// unchanged — until the full-interval cap (HEARTBEAT_FULL_INTERVAL_MS,
// default 2h) forces a run anyway. The trade-off is that anything the probe
// can't see surfaces within the cap rather than within the tick interval.
// /heartbeat bypasses the filter.
let lastFullHeartbeatAt = 0;
let lastProbeHash = null;

/**
 * Hash the pre-check endpoint's response, if one is configured.
 *
 * :returns: A hex digest, or ``null`` when there is no probe URL or the probe
 *   failed — either way the caller runs the full heartbeat rather than
 *   assuming nothing changed.
 */
async function heartbeatProbe() {
  if (!config.heartbeatProbeUrl) return null;
  try {
    const headers = {};
    if (process.env.HEARTBEAT_PROBE_HEADER) {
      const [name, ...rest] = process.env.HEARTBEAT_PROBE_HEADER.split(":");
      headers[name.trim()] = rest.join(":").trim();
    }
    const res = await fetch(config.heartbeatProbeUrl, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log("warn", "heartbeat-probe-failed", { status: res.status });
      return null;
    }
    const body = await res.text();
    const { createHash } = await import("crypto");
    return createHash("sha256").update(body).digest("hex");
  } catch {
    return null; // probe unavailable → fall through to a full heartbeat
  }
}

/**
 * Run one heartbeat.
 *
 * :returns: An outcome the caller can report honestly — ``{ ran: false,
 *   reason }`` when the run was skipped, ``{ ran: true, delivered }`` when the
 *   model actually ran. /heartbeat must not claim success for a run that
 *   never happened.
 */
async function runHeartbeat({ force = false } = {}) {
  if (heartbeatRunning) { log("info", "heartbeat-skip", { reason: "already-running" }); return { ran: false, reason: "already-running" }; }
  if (!force && isQuietHours()) { log("info", "heartbeat-skip", { reason: "quiet-hours" }); return { ran: false, reason: "quiet-hours" }; }

  const heartbeatPrompt = buildHeartbeatPrompt();
  if (!heartbeatPrompt) {
    const reason = config.heartbeatPromptFile ? "prompt-file-unreadable" : "not-configured";
    log("info", "heartbeat-skip", { reason });
    return { ran: false, reason };
  }

  if (!force && Date.now() - lastFullHeartbeatAt < config.heartbeatFullIntervalMs) {
    const probeHash = await heartbeatProbe();
    if (probeHash !== null && probeHash === lastProbeHash) {
      log("info", "heartbeat-skip", {
        reason: "precheck-unchanged",
        nextFullInMin: Math.round((config.heartbeatFullIntervalMs - (Date.now() - lastFullHeartbeatAt)) / 60000),
      });
      return { ran: false, reason: "probe-unchanged" };
    }
    if (probeHash !== null) lastProbeHash = probeHash;
  }

  heartbeatRunning = true;
  const startTime = Date.now();
  log("info", "heartbeat-start");

  // Same subprocess-slot discipline as interactive queries and cron jobs —
  // but bounded: an unbounded FIFO wait would hold heartbeatRunning=true for
  // up to a full query wall-clock (30 min), silently skipping every tick in
  // between. Better to skip THIS tick with a log and try again in 30 min.
  const HEARTBEAT_ACQUIRE_TIMEOUT_MS = 2 * 60 * 1000;
  const acquired = await querySemaphore.acquireWithin(HEARTBEAT_ACQUIRE_TIMEOUT_MS);
  if (!acquired) {
    heartbeatRunning = false;
    log("warn", "heartbeat-skip", {
      reason: "semaphore-busy",
      waitedMs: Date.now() - startTime,
      active: querySemaphore.active,
      queued: querySemaphore.queued,
    });
    return { ran: false, reason: "semaphore-busy" };
  }

  const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), HEARTBEAT_TIMEOUT_MS);

  try {
    let resultText = "", cost = 0, turns = 0, modelsUsed = [];

    // Through the same picker as everything else, so ANTHROPIC_MODEL_FORCE
    // applies and heartbeat spend shows up in the /costs breakdown.
    const model = pickModel(process.env.HEARTBEAT_MODEL || null, "heartbeat");

    for await (const message of query({
      prompt: heartbeatPrompt,
      options: {
        cwd: config.cwd,
        model,
        // No fallback when ANTHROPIC_MODEL_FORCE is pinning all traffic.
        ...(config.modelForce ? {} : { fallbackModel: fallbackModelFor(model, config) }),
        env: { ...process.env, ...sdkResilienceEnv(), BRIDGE_DELIVER_TO: String(config.heartbeatDeliveryChat) },
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 15, effort: "medium",
        persistSession: false,
        abortController,
        stderr: (chunk) => log("error", "claude-stderr", { source: "heartbeat", chunk: String(chunk).trim() }),
      },
    })) {
      // Fallback engagement must never be silent (same rule as runClaude).
      if (message.type === "system" && message.subtype === "model_refusal_fallback") {
        log("warn", "model-fallback-engaged", {
          source: "heartbeat",
          from: message.original_model || model,
          to: message.fallback_model,
          category: message.api_refusal_category ?? null,
        });
      }
      if (message.type === "result") {
        resultText = message.result || "";
        cost = message.total_cost_usd || 0;
        turns = message.num_turns || 0;
        modelsUsed = Object.keys(message.modelUsage || {});
      }
    }

    const durationMs = Date.now() - startTime;
    const suppressed = isHeartbeatOk(resultText);
    if (modelsUsed.length > 0 && !usedPrimaryModel(model, modelsUsed)) {
      log("warn", "primary-model-not-used", { source: "heartbeat", routed: model, modelsUsed });
    }
    trackCost("heartbeat", cost, { model });
    log("info", "heartbeat-done", { durationMs, cost, turns, suppressed, model, modelsUsed });

    // Pre-filter bookkeeping: reset the full-interval clock and re-baseline
    // the probe so the next ticks compare against post-run state.
    lastFullHeartbeatAt = Date.now();
    lastProbeHash = await heartbeatProbe();

    if (!suppressed && resultText.trim().length > 0) {
      await sendLongMessage(Number(config.heartbeatDeliveryChat), resultText);
      return { ran: true, delivered: true };
    }
    return { ran: true, delivered: false };
  } catch (err) {
    const isTimeout = err.name === "AbortError";
    const durationMs = Date.now() - startTime;
    log("error", "heartbeat-error", { error: err.message, isTimeout, durationMs });

    // Surface a timeout — a heartbeat that quietly stops checking is worse
    // than one that says it's struggling.
    if (isTimeout) {
      try {
        await sendLongMessage(
          Number(config.heartbeatDeliveryChat),
          `⚠️ Heartbeat timed out after ${Math.round(durationMs / 1000)}s — checks may be incomplete.`
        );
      } catch { /* don't cascade */ }
    }
    return { ran: true, delivered: false, error: err.message, timedOut: isTimeout };
  } finally {
    clearTimeout(timeoutHandle);
    querySemaphore.release();
    heartbeatRunning = false;
  }
}

function startHeartbeat() {
  if (!config.heartbeatPromptFile) {
    log("info", "heartbeat-disabled", {
      hint: "Set HEARTBEAT_PROMPT_FILE to a file describing what to check.",
    });
    return;
  }
  log("info", "heartbeat-scheduler-start", {
    intervalMs: config.heartbeatIntervalMs,
    quietHours: `${config.quietStart}:00-${config.quietEnd}:00`,
    timezone: config.timezone,
  });
  setTimeout(() => runHeartbeat(), 10_000);
  heartbeatTimer = setInterval(() => runHeartbeat(), config.heartbeatIntervalMs);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

startHeartbeat();

// ---------------------------------------------------------------------------
// Start cron scheduler
// ---------------------------------------------------------------------------

setCronDeps({ log, sendLongMessage });
const cronCount = await startCronScheduler();

// ---------------------------------------------------------------------------
// Start the control API server
// ---------------------------------------------------------------------------

setApiDeps({
  agents,
  listCronJobs,
  triggerCronJob,
  hasCronJob,
  getDailyCosts,
  chatSessions,
  activeTasks,
  runClaude,
  sendLongMessage,
  log,
  heartbeatRunning: () => heartbeatRunning,
  isQuietHours,
});
// ---------------------------------------------------------------------------
// Optional extensions module
// ---------------------------------------------------------------------------

let extensionsLoaded = false;
if (config.extensionsFile) {
  const extPath = resolvePath(config.extensionsFile.replace(/^~(?=\/|$)/, homedir()));
  if (existsSync(extPath)) {
    try {
      const ext = await import(pathToFileURL(extPath).href);
      if (typeof ext.register === "function") {
        await ext.register({ bot, config, log, auditLog, sendLongMessage });
        extensionsLoaded = true;
        log("info", "extensions-loaded", { path: extPath });
      } else {
        log("warn", "extensions-missing-register", { path: extPath });
      }
    } catch (err) {
      log("error", "extensions-load-failed", { path: extPath, error: err.message });
    }
  } else {
    log("warn", "extensions-file-not-found", { path: extPath });
  }
}

log("info", "All systems online", {
  agents: Object.keys(agents).length,
  cronJobs: cronCount,
  apiPort: config.apiPort,
  ...(config.extensionsFile ? { extensions: extensionsLoaded } : {}),
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  log("info", `Received ${signal}, shutting down`);
  stopHeartbeat();
  stopCronScheduler();
  chatSessions.stopCleanupTimer();
  chatSessions.save();
  mediaGroupDebouncer.clear();
  for (const [, pending] of pendingFileMessages) clearTimeout(pending.timer);
  pendingFileMessages.clear();

  // API server: force-close all active connections so the port actually
  // releases, then await the close event. Without this, a fast service
  // restart hits EADDRINUSE because the kernel is still holding the socket.
  // closeAllConnections() requires Node 18.2+.
  if (typeof apiServer.closeAllConnections === "function") {
    apiServer.closeAllConnections();
  }
  const apiClosed = new Promise((resolve) => {
    apiServer.close(() => resolve());
    // Hard cap so we don't hang shutdown if close() never fires
    setTimeout(resolve, 2000);
  });

  // Notify any active chats BEFORE aborting — closes the silent-abort gap
  const activeChatIds = [...activeTasks.keys()];
  if (activeChatIds.length > 0) {
    log("info", "notifying-active-chats-of-shutdown", { chatIds: activeChatIds });
    const notifyPromises = activeChatIds.map((chatId) =>
      bot.sendMessage(chatId, "⚠️ Bridge restarting — your last message was interrupted. Please resend.")
        .catch((err) => log("warn", "shutdown-notify-failed", { chatId, error: err.message }))
    );
    // Bound the wait so we don't hang shutdown indefinitely
    await Promise.race([
      Promise.all(notifyPromises),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  }

  for (const [chatId, controller] of activeTasks) {
    controller.abort();
    log("info", "Aborted active task", { chatId });
  }
  bot.stopPolling();

  // Wait for the API server socket to fully release before exit.
  await apiClosed;

  log("info", "Shutdown complete", { sessionsSaved: chatSessions.size });
  // Exit with code 1 so launchd KeepAlive.SuccessfulExit=false will restart us
  process.exit(1);
}

// Guard against re-entrant shutdown (e.g. two rapid SIGTERMs before process.exit fires)
let shutdownInProgress = false;

function handleSignal(signal) {
  if (shutdownInProgress) {
    log("warn", "shutdown-already-in-progress", { signal });
    return;
  }
  shutdownInProgress = true;
  shutdown(signal);
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

// A lone unhandled rejection is logged and survivable. A storm of them means
// the process is in an undefined state — restart cleanly via launchd rather
// than limping on with dead transports/timers. Threshold: 10 in 5 minutes
// (override with UNHANDLED_REJECTION_EXIT_THRESHOLD).
const rejectionTracker = new RejectionTracker({
  threshold: Number(process.env.UNHANDLED_REJECTION_EXIT_THRESHOLD) || 10,
  windowMs: 5 * 60_000,
});
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled-rejection", {
    reason: String(reason),
    stack: reason?.stack ? String(reason.stack).split("\n").slice(0, 5).join("\n") : undefined,
  });
  // Network-class and Telegram-API rejections (fire-and-forget
  // bot.sendMessage during an outage or 429 burst) are excluded from the
  // storm counter: a restart can't fix an upstream outage and would just
  // kill in-flight Claude queries and cron jobs. The polling watchdogs
  // already own transport-death recovery. Only unexplained rejections count.
  if (isNetworkClassPollingError(reason) || reason?.code === "ETELEGRAM") return;
  if (rejectionTracker.record()) {
    log("error", "unhandled-rejection-storm-exit", {
      count: rejectionTracker.count,
      windowMs: 5 * 60_000,
    });
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// EPIPE crash safety net (2026-07-05)
//
// node-telegram-bot-api's HTTP client (@cypress/request, a `request` fork)
// keeps a keep-alive http.Agent socket pool. Under network flakiness (seen
// repeatedly in stdout.log as watchdog-getme-probe-failed / ESOCKETTIMEDOUT /
// "socket disconnected before secure TLS connection was established" right
// before every crash below), a pooled socket can die mid-blip and get reused
// for the next outbound write. That write then EPIPEs on a raw Socket
// instance that's fully internal to the library/Node's http internals —
// never exposed to this file. Investigated every spawn/execFile call site in
// this repo (ffmpeg, whisper, ps — all callback-style, no direct stdin
// writes) and the only server we own (api-server.mjs, whose req/res streams
// already have error handlers) — none of them are the source, so there is no
// `child.stdin` / `net.Socket` reference reachable here to attach a scoped
// `.on('error')` handler to.
//
// Confirmed crash signature (11 occurrences on 2026-07-05, incl. a ~22-min
// outage 15:27-15:49):
//   node:events:497 throw er; // Unhandled 'error' event
//   Error: write EPIPE ... Emitted 'error' event on Socket instance
//
// This is the documented last-resort: narrowly scoped to EPIPE only.
// Anything else rethrows (via process.exit) — do NOT widen this into a
// general uncaughtException swallow.
//
// 2026-07-06 fast-follow: suppressing the EPIPE is a bet that the process is
// still alive/useful — unproven at suppression time. lastEpipeSuppressedAt
// feeds the zombie-EPIPE watchdog below, which exits if no poll signal
// (inbound message or successful proof-of-life probe) lands within
// ZOMBIE_EPIPE_WATCHDOG_MS afterwards, converting an unproven "suppression
// saved a dead process" case back into a fast, clean restart.
process.on("uncaughtException", (err) => {
  if (isSuppressibleEpipe(err)) {
    lastEpipeSuppressedAt = Date.now();
    log("warn", "uncaught-epipe-suppressed", {
      message: err.message,
      syscall: err.syscall,
    });
    return;
  }
  log("error", "uncaught-exception-fatal", {
    message: err?.message,
    stack: err?.stack,
    code: err?.code,
  });
  process.exit(1);
});

// Zombie-EPIPE watchdog: checked on the same 60s cadence as the polling
// staleness watchdog below. See error-classify.mjs shouldExitAsZombie() for
// the pure decision function this mirrors.
const zombieEpipeWatchdogTimer = setInterval(() => {
  if (shutdownInProgress) return;
  if (shouldExitAsZombie(lastEpipeSuppressedAt, Date.now())) {
    log("error", "watchdog-zombie-epipe", {
      msSinceSuppression: Date.now() - lastEpipeSuppressedAt,
      thresholdMs: ZOMBIE_EPIPE_WATCHDOG_MS,
    });
    process.exit(1);
  }
}, 60_000);
zombieEpipeWatchdogTimer.unref?.();

// ---------------------------------------------------------------------------
// Orphan SDK subprocess reaper
//
// The claude-agent-sdk subprocess sometimes fails to exit cleanly after
// query() completes — most reliably when the Agent (subagent) tool has been
// used, because the SDK can be left waiting on MCP-server children that
// never close. Symptom: the bridge logs a successful "Claude response"
// but the child `claude --output-format stream-json ... --resume <sid>`
// process stays alive for hours, holding ~300 MB and the chat's
// activeTasks slot, blocking new messages on that chat.
//
// This reaper runs every 60s. It enumerates direct children of this
// process whose command line matches the SDK binary AND carries a
// `--resume <sessionId>` flag (so cron + heartbeat subprocesses, which
// don't resume, are untouched). For each such child it decides:
//
//   1. sessionId not in chatSessions store → orphan (rotated/deleted)
//   2. owning chat is NOT in activeTasks → orphan (bridge thinks done)
//   3. owning chat IS in activeTasks BUT the chat's lastActivity is
//      meaningfully newer than the process's start → orphan (a newer
//      query for the same chat replaced this one)
//
// Then SIGTERM, escalate to SIGKILL after 5s. A 60s grace prevents
// reaping legitimate in-flight queries.
// ---------------------------------------------------------------------------

const ORPHAN_SWEEP_INTERVAL_MS = 60 * 1000;
const ORPHAN_GRACE_SECONDS = 60;
const ORPHAN_OVERLAP_SLACK_MS = 30 * 1000;

function chatIdForSessionId(sessionId) {
  for (const [chatId, info] of chatSessions.entries()) {
    if (info?.sessionId === sessionId) return chatId;
  }
  return null;
}

function parsePsEtime(s) {
  // ps etime format: [[DD-]HH:]MM:SS
  let days = 0;
  let rest = s;
  const dayMatch = rest.match(/^(\d+)-(.+)$/);
  if (dayMatch) { days = Number(dayMatch[1]); rest = dayMatch[2]; }
  const parts = rest.split(":").map(Number);
  let h = 0, m = 0, sec = 0;
  if (parts.length === 3) [h, m, sec] = parts;
  else if (parts.length === 2) [m, sec] = parts;
  else sec = parts[0] || 0;
  return days * 86400 + h * 3600 + m * 60 + sec;
}

function listSDKChildren() {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,etime=,command="],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve([]); return; }
        const myPid = process.pid;
        const result = [];
        for (const line of stdout.split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
          if (!m) continue;
          const pid = Number(m[1]);
          const ppid = Number(m[2]);
          if (ppid !== myPid) continue;
          const cmd = m[4];
          if (!cmd.includes("@anthropic-ai/claude-agent-sdk")) continue;
          const sessionMatch = cmd.match(/--resume\s+([0-9a-fA-F-]+)/);
          if (!sessionMatch) continue; // skip cron/heartbeat (no --resume)
          result.push({
            pid,
            etime: m[3],
            etimeSeconds: parsePsEtime(m[3]),
            sessionId: sessionMatch[1],
          });
        }
        resolve(result);
      });
  });
}

function escalateKill(pid) {
  setTimeout(() => {
    try {
      process.kill(pid, 0); // throws ESRCH if already dead
      process.kill(pid, "SIGKILL");
      log("warn", "orphan-sdk-sigkill", { pid });
    } catch { /* already gone, fine */ }
  }, 5000).unref?.();
}

async function reapOrphanSDKChildren() {
  let children;
  try {
    children = await listSDKChildren();
  } catch (err) {
    log("warn", "orphan-reaper-list-failed", { error: err.message });
    return;
  }
  const now = Date.now();
  for (const child of children) {
    if (child.etimeSeconds < ORPHAN_GRACE_SECONDS) continue;

    const chatId = chatIdForSessionId(child.sessionId);
    let isOrphan = false;
    let reason = "";

    if (chatId === null) {
      isOrphan = true;
      reason = "session-rotated-or-deleted";
    } else if (!activeTasks.has(chatId)) {
      isOrphan = true;
      reason = "chat-not-active";
    } else {
      const session = chatSessions.get(chatId);
      const processStartedAt = now - child.etimeSeconds * 1000;
      if (session?.lastActivity &&
          session.lastActivity > processStartedAt + ORPHAN_OVERLAP_SLACK_MS) {
        isOrphan = true;
        reason = "process-older-than-last-activity";
      }
    }

    if (!isOrphan) continue;

    log("warn", "orphan-sdk-reap", {
      pid: child.pid,
      sessionId: child.sessionId,
      chatId,
      etime: child.etime,
      reason,
    });
    try { process.kill(child.pid, "SIGTERM"); } catch (err) {
      log("warn", "orphan-sdk-sigterm-failed", { pid: child.pid, error: err.message });
      continue;
    }
    escalateKill(child.pid);
  }
}

const orphanReaperTimer = setInterval(() => {
  if (shutdownInProgress) return;
  reapOrphanSDKChildren().catch((err) =>
    log("warn", "orphan-reaper-error", { error: err.message }));
}, ORPHAN_SWEEP_INTERVAL_MS);
orphanReaperTimer.unref?.();

// Polling liveness watchdog. node-telegram-bot-api can silently wedge after
// EFATAL/ECONNRESET; bot.isPolling() lies. Use message arrival as ground truth.
// 30 min default (was 15 min): the getMe probe above refreshes lastPollSignalAt
// every 5 min during waking hours, so a truly dead bridge will be caught at the
// next 5-min probe cycle — the 30 min threshold is belt-and-braces for cases
// where getMe itself fails (network loss). 15 min was too aggressive and fired
// on idle periods with no inbound user messages (false positives, 2026-06-23).
// Override with POLLING_STALE_MS env var.
const POLLING_STALE_MS = Number(process.env.POLLING_STALE_MS) || 30 * 60 * 1000;
// 2026-07-11: runs 24/7 now (was: disabled 23:00-08:00, leaving an overnight
// coverage hole for wedges with zero pending updates). The getWebHookInfo
// probe below refreshes lastPollSignalAt around the clock — but only when
// pending_update_count is 0, so a wedged poller with a few undrained updates
// still trips this watchdog instead of being masked by API reachability. An
// idle night (pending 0 every probe) no longer false-positives; the
// quiet-hours multiplier (3× threshold) adds extra tolerance overnight.
setInterval(() => {
  if (shutdownInProgress) return;
  // Same timezone + quiet-hours window as everything else, not the host's
  // local clock — all time-of-day logic reads from one config.
  const threshold = staleThresholdMs(hourInConfigTz(), POLLING_STALE_MS, {
    quietStart: config.quietStart,
    quietEnd: config.quietEnd,
  });
  const stale = Date.now() - lastPollSignalAt;
  if (stale > threshold) {
    log("error", "watchdog-polling-stalled", { staleMs: stale, thresholdMs: threshold });
    process.exit(1);
  }
}, 60_000);

// getMe probe — keeps lastPollSignalAt fresh during idle periods so the
// polling-liveness watchdog doesn't false-positive on quiet days. Confirms
// the polling transport is alive even when no inbound user messages arrive.
// Without this, an idle bridge during waking hours triggers
// watchdog-polling-stalled every 15 min and launchd respawns it (~15min cycle).
// Default 5 min — short enough to keep clock fresh, long enough to be cheap.
// Override with GETME_PROBE_INTERVAL_MS env var.
const GETME_PROBE_INTERVAL_MS = Number(process.env.GETME_PROBE_INTERVAL_MS) || 5 * 60 * 1000;
setInterval(async () => {
  if (shutdownInProgress) return;
  if (isQuietHours()) return;
  try {
    await bot.getMe();
    lastPollSignalAt = Date.now();
    // Proof-of-life: a successful call over the same transport means any
    // accumulated network-class polling errors were transient blips, not a
    // wedged connection. Reset so isolated overnight blips (no inbound
    // messages to reset via the "message" handler) can't quietly accumulate
    // toward the exit(1) threshold in polling_error.
    consecutiveNetworkPollingErrors = 0;
    // Also clears any outstanding EPIPE-zombie marker — a successful call
    // over the same transport proves the process isn't a zombie.
    lastEpipeSuppressedAt = null;
    // Don't log success — would spam stdout every 5 min.
    // Health-check covers "is the bridge OK" visibility.
  } catch (err) {
    log("warn", "watchdog-getme-probe-failed", { error: err.message });
  }
}, GETME_PROBE_INTERVAL_MS);

// Ground-truth watchdog: poll Telegram's getWebHookInfo every 5 min. If
// pending_update_count keeps climbing, our polling loop isn't draining the
// queue — exit so launchd restarts. Catches the case where no real user
// messages arrive for hours but polling is silently dead (10 May 2026 incident).
//
// 2026-07-05 fix: the probe itself failing (not just returning a bad count)
// is equally strong evidence of a wedged/network-cut bridge, but the catch
// block below used to just log and do nothing — during a sustained outage
// every 5-min tick hits this branch, so the watchdog silently never fired
// exactly when it was needed most (contributed to the ~22-26 min outage
// window). Both branches now feed the same streak counter.
const PENDING_UPDATES_THRESHOLD = 5;
let pendingUpdatesStreak = 0;
setInterval(async () => {
  if (shutdownInProgress) return;
  try {
    const info = await bot.getWebHookInfo();
    // Any successful return — regardless of pending count — proves the
    // transport itself is alive, which is all the EPIPE-zombie watchdog
    // cares about. Previously this only cleared in the low-pending branch
    // below, so a high-pending-but-alive tick left a stale marker in place.
    lastEpipeSuppressedAt = null;
    const pending = info.pending_update_count || 0;
    // Refresh the staleness clock ONLY when the update queue is empty. This
    // probe runs 24/7 (unlike getMe, which is waking-hours only), which is
    // what lets the polling-staleness watchdog run overnight without
    // false-positiving on idle nights — but an unconditional refresh would
    // mask the exact wedge it exists to catch: getUpdates dead while the
    // HTTPS API stays reachable and 1-5 messages sit pending (below the
    // pending-streak threshold). pending === 0 is the only probe result that
    // is evidence of a draining poller rather than mere API reachability.
    if (pending === 0) lastPollSignalAt = Date.now();
    if (pending > PENDING_UPDATES_THRESHOLD) {
      pendingUpdatesStreak++;
      log("warn", "watchdog-pending-updates", { pending, streak: pendingUpdatesStreak });
      if (pendingUpdatesStreak >= 2) {
        log("error", "watchdog-polling-deaf", { pending, streak: pendingUpdatesStreak });
        process.exit(1);
      }
    } else {
      pendingUpdatesStreak = 0;
      // Proof-of-life over the same transport (also runs during quiet
      // hours, unlike the getMe probe above) — reset the network-error
      // streak so isolated blips don't accumulate toward polling_error's
      // exit(1) threshold across long inbound-message-free stretches.
      consecutiveNetworkPollingErrors = 0;
    }
  } catch (err) {
    pendingUpdatesStreak++;
    log("warn", "watchdog-probe-failed", { error: err.message, streak: pendingUpdatesStreak });
    if (pendingUpdatesStreak >= 2) {
      log("error", "watchdog-polling-deaf", { reason: "probe-failed", error: err.message, streak: pendingUpdatesStreak });
      process.exit(1);
    }
  }
}, PENDING_PROBE_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Health check — every 5 minutes
// ---------------------------------------------------------------------------

setInterval(() => {
  const costs = getDailyCosts();
  log("info", "health-check", {
    sessions: chatSessions.size,
    activeTasks: activeTasks.size,
    heartbeatRunning,
    quietHours: isQuietHours(),
    dailyCost: costs.total,
  });

}, 5 * 60 * 1000);
