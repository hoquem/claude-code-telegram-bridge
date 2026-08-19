/**
 * Central configuration, read once from the environment at startup.
 *
 * Everything the bridge needs to know about *your* setup lives here or in the
 * files this points at. Nothing about a particular deployment is baked into
 * the source.
 *
 * Required: TELEGRAM_BOT_TOKEN, ALLOWED_TELEGRAM_USERS.
 * See .env.example for the full list with defaults.
 */

import { join } from "path";
import { homedir } from "os";

const HOME = process.env.HOME || homedir();

/** Parse a comma-separated numeric id list into a Set of Numbers. */
function idSet(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n))
  );
}

// ---------------------------------------------------------------------------
// Required settings — fail at startup, not on the first message.
//
// ALLOWED_TELEGRAM_USERS has deliberately no default. A default allowlist
// would mean every fresh install trusts whoever the default names, and an
// empty default would mean the bot silently ignores its owner. Both are worse
// than refusing to boot.
// ---------------------------------------------------------------------------

const allowedUsers = idSet(process.env.ALLOWED_TELEGRAM_USERS);
if (allowedUsers.size === 0) {
  console.error(
    "ALLOWED_TELEGRAM_USERS is required: a comma-separated list of Telegram " +
    "user IDs permitted to talk to this bot. Message @userinfobot on Telegram " +
    "to find yours."
  );
  process.exit(1);
}

// First allowed user is the operator: the default target for heartbeat output,
// API dispatches with no chat_id, and sensitive-content redirects.
const defaultChatId = process.env.DEFAULT_CHAT_ID || String([...allowedUsers][0]);

/** Optional {chatId: "friendly name"} map, for the /api/agents session list. */
function parseChatNames(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`CHAT_NAMES is not valid JSON, ignoring it: ${err.message}`);
    return {};
  }
}

export const config = {
  // --- Telegram ---
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  allowedUsers,
  // Empty = direct messages only; the bot ignores every group it's added to.
  allowedGroups: idSet(process.env.ALLOWED_TELEGRAM_GROUPS),
  chatNames: parseChatNames(process.env.CHAT_NAMES),
  defaultChatId,

  // --- Identity ---
  // Shown in /start, /help, and the control API. The assistant's actual
  // persona comes from the CLAUDE.md in `cwd`, not from this string.
  assistantName: process.env.ASSISTANT_NAME || "Claude",

  // --- Paths ---
  // Working directory for every Claude session: its CLAUDE.md, skills, and
  // MCP servers are what give the bot its identity and tools.
  cwd: process.env.CLAUDE_CWD || join(HOME, "claude-bridge-workspace"),
  // Persistent state: sessions, per-chat prefs, the quiet-hours alert queue.
  // Separate from logDir on purpose — these used to be derived by walking out
  // of it, so pointing LOG_DIR at /var/log put session state in /var.
  stateDir: process.env.STATE_DIR || join(HOME, ".claude-telegram-bridge"),
  logDir: process.env.LOG_DIR || join(HOME, ".claude-telegram-bridge", "logs"),
  downloadDir: process.env.DOWNLOAD_DIR || join(HOME, ".claude-telegram-bridge", "downloads"),

  // --- Voice transcription (optional) ---
  // Bare names resolve through PATH. Set absolute paths when running under a
  // service manager with a minimal PATH (launchd, systemd).
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  whisperPath: process.env.WHISPER_PATH || "whisper",
  whisperModel: process.env.WHISPER_MODEL || "tiny",
  whisperLanguage: process.env.WHISPER_LANGUAGE || "en",
  // Prepended to PATH for the two binaries above (e.g. /opt/homebrew/bin).
  extraPath: process.env.EXTRA_PATH || "",

  // --- Heartbeat (optional) ---
  // A periodic self-directed check-in. Disabled unless you point
  // HEARTBEAT_PROMPT_FILE at a file describing what to check.
  heartbeatPromptFile: process.env.HEARTBEAT_PROMPT_FILE || null,
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || String(30 * 60 * 1000)),
  heartbeatFullIntervalMs: parseInt(process.env.HEARTBEAT_FULL_INTERVAL_MS || String(2 * 60 * 60 * 1000)),
  heartbeatDeliveryChat: process.env.HEARTBEAT_DELIVERY_CHAT || defaultChatId,
  // Cheap pre-check: an HTTP endpoint hashed each tick. While its response is
  // unchanged, the expensive LLM heartbeat is skipped until the full-interval
  // cap elapses. Leave unset to run every tick.
  heartbeatProbeUrl: process.env.HEARTBEAT_PROBE_URL || null,

  // --- Cron (optional) ---
  // Path to a module default-exporting an array of job definitions.
  // See cron-jobs.example.mjs for the shape.
  cronJobsFile: process.env.CRON_JOBS_FILE || null,
  // Where a job's final-failure alert goes when the job itself is silent.
  cronErrorChat: process.env.CRON_ERROR_CHAT || defaultChatId,

  // --- Sensitive-content guard (optional) ---
  // Comma-separated words. An outbound message matching one on a word
  // boundary is redirected to sensitiveRedirectChat instead of the group it
  // was headed for. Case-insensitive. Leave unset to disable.
  sensitiveKeywords: String(process.env.SENSITIVE_KEYWORDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
  sensitiveRedirectChat: process.env.SENSITIVE_REDIRECT_CHAT || defaultChatId,

  // --- Control API ---
  apiPort: parseInt(process.env.API_PORT || "8091"),
  // No key = every /api/* route returns 401. /livez stays open for watchdogs.
  apiKey: process.env.BRIDGE_API_KEY || "",

  // --- Time ---
  // IANA name. Every schedule, quiet-hours check, and timestamp the bridge
  // reasons about uses this rather than the host clock's local zone.
  timezone: process.env.BRIDGE_TIMEZONE || "UTC",
  // Nothing non-urgent goes out between these hours. Cron alerts and
  // operator-destined output queue up and flush shortly after quietEnd.
  quietStart: parseInt(process.env.QUIET_HOURS_START || "23"),
  quietEnd: parseInt(process.env.QUIET_HOURS_END || "8"),

  // --- Limits ---
  maxResponseLength: 4096,

  // --- Models ---
  // Tier names ("fable"/"sonnet"/"haiku") are the vocabulary used by /model,
  // by a subagent's `model:` frontmatter, and by a cron job's `model` field.
  // The ids each tier resolves to are overridable so tier names survive model
  // releases.
  fableModel: process.env.FABLE_MODEL_ID || "claude-fable-5",
  sonnetModel: process.env.SONNET_MODEL_ID || "claude-sonnet-4-5",
  haikuModel: process.env.HAIKU_MODEL_ID || "claude-haiku-4-5",
  defaultModelTier: process.env.DEFAULT_MODEL_TIER || "sonnet",
  // Kill switch: routes ALL traffic to one model id, ignoring every pin.
  modelForce: process.env.ANTHROPIC_MODEL_FORCE || null,
};
