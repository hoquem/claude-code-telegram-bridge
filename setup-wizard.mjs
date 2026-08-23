#!/usr/bin/env node
/**
 * Guided first-time setup. Run with ``npm run init``.
 *
 * Gets you from a clean checkout to a working bot, checking the things that
 * otherwise fail silently or hours later:
 *
 *   - Node and Claude Code are present, and Claude is actually logged in.
 *   - The bot token works, verified against Telegram rather than assumed.
 *   - Group privacy mode is off, which Telegram enables by default and which
 *     otherwise makes the bot deaf to ordinary group messages.
 *   - Your user id and any group ids, discovered by watching for a real
 *     message rather than sending you to a third-party bot for them.
 *   - A workspace with a CLAUDE.md, because the bridge refuses to start
 *     without one and the SDK's error if it were missing is opaque.
 *
 * Safe to re-run: existing .env values become the defaults, and nothing is
 * written until the summary is confirmed.
 */

import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { execFileSync } from "child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, copyFileSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, ".env");
// Telegram supports self-hosted Bot API servers, so this is overridable.
// It is also the seam the end-to-end test uses to drive the wizard against a
// fake Telegram instead of the real one.
const API = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

// --- output -----------------------------------------------------------------

const c = process.stdout.isTTY
  ? { b: "\x1b[1m", dim: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", x: "\x1b[0m" }
  : { b: "", dim: "", g: "", y: "", r: "", x: "" };

const say = (s = "") => console.log(s);
const ok = (s) => say(`  ${c.g}✓${c.x} ${s}`);
const warn = (s) => say(`  ${c.y}!${c.x} ${s}`);
const bad = (s) => say(`  ${c.r}✗${c.x} ${s}`);
const step = (n, total, title) => say(`\n${c.b}[${n}/${total}] ${title}${c.x}`);

function die(message, hint) {
  say();
  bad(message);
  if (hint) say(`\n${hint}\n`);
  process.exit(1);
}

// --- prompting --------------------------------------------------------------

let rl;
let inputEnded;

/** Distinguishes "stdin ended" from every other failure. */
class InputEnded extends Error {}

/**
 * Arm the end-of-input guard. Call once, after the interface exists.
 *
 * readline's question() does not reject when stdin ends; it simply never
 * settles, and Node exits with "detected unsettled top-level await". Racing
 * every prompt against the close event turns that into a real error with a
 * message that names the actual problem.
 */
let stdinClosed = false;
function watchForInputEnd() {
  inputEnded = new Promise((_, reject) => {
    rl.once("close", () => { stdinClosed = true; reject(new InputEnded()); });
  });
  inputEnded.catch(() => {});  // the race usually wins; never warn about it
}

function prompt(text) {
  // Asking after the stream is gone throws "readline was closed", which is
  // true but tells the reader nothing about what to do.
  if (stdinClosed) return Promise.reject(new InputEnded());
  return Promise.race([rl.question(text), inputEnded]);
}

async function ask(question, { fallback = "", secret = false } = {}) {
  const suffix = fallback ? ` ${c.dim}[${secret ? mask(fallback) : fallback}]${c.x}` : "";
  const answer = (await prompt(`  ${question}${suffix}: `)).trim();
  return answer || fallback;
}

async function confirm(question, defaultYes = true) {
  const answer = (await prompt(`  ${question} ${c.dim}[${defaultYes ? "Y/n" : "y/N"}]${c.x}: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y");
}

const mask = (s) => (s && s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : "set");

// --- Telegram ---------------------------------------------------------------

async function telegram(token, method, params = {}) {
  const url = new URL(`${API}/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal: AbortSignal.timeout(70_000) });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) {
    const err = new Error(body.description || `HTTP ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return body.result;
}

/**
 * Wait for someone to send the bot a message, and return it.
 *
 * Drains anything already queued first, so a message from last week can't be
 * mistaken for the confirmation we just asked for.
 */
async function waitForMessage(token, { accept, timeoutMs = 180_000 }) {
  let offset;
  const drained = await telegram(token, "getUpdates", { timeout: 0 });
  if (drained.length > 0) offset = drained[drained.length - 1].update_id + 1;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const updates = await telegram(token, "getUpdates", {
      timeout: 25,
      ...(offset !== undefined ? { offset } : {}),
    });
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message || u.channel_post;
      if (msg && accept(msg)) return msg;
    }
  }
  return null;
}

// --- .env -------------------------------------------------------------------

function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Write settings into .env, preserving the example file's comments and layout
 * so the result still reads as documentation rather than a bare dump.
 */
function writeEnvFile(path, values) {
  const template = join(HERE, ".env.example");
  let lines = existsSync(path)
    ? readFileSync(path, "utf8").split("\n")
    : readFileSync(template, "utf8").split("\n");

  const remaining = { ...values };
  lines = lines.map((line) => {
    const m = line.match(/^\s*#?\s*([A-Z0-9_]+)\s*=/);
    if (!m || !(m[1] in remaining)) return line;
    const key = m[1];
    const value = remaining[key];
    delete remaining[key];
    return value === null ? line : `${key}=${value}`;
  });

  const extra = Object.entries(remaining).filter(([, v]) => v !== null);
  if (extra.length > 0) {
    lines.push("", "# Added by npm run init");
    for (const [k, v] of extra) lines.push(`${k}=${v}`);
  }

  writeFileSync(path, lines.join("\n"));
  chmodSync(path, 0o600);
}

// --- checks -----------------------------------------------------------------

/** Locate a binary on PATH. Returns its path, or "" if absent. */
function which(bin) {
  try {
    return execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function checkNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  // 20.12 specifically: --env-file-if-exists, which npm start uses.
  if (major < 20 || (major === 20 && minor < 12)) {
    die(`Node ${process.versions.node} is too old.`,
        "Install Node 20.12 or newer, then run this again.");
  }
  ok(`Node ${process.versions.node}`);
}

function checkClaude() {
  const path = which("claude");
  if (!path) {
    die("Claude Code is not on your PATH.",
        `Install it first: ${c.b}https://claude.com/claude-code${c.x}\n` +
        "  The bridge runs real Claude Code sessions, so it needs the CLI.");
  }

  let version = "";
  try {
    version = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
  } catch {
    warn(`Found ${path} but could not run it. Continuing.`);
    return;
  }
  ok(`Claude Code: ${version}`);

  // Authentication is the failure that would otherwise show up as an opaque
  // SDK error on the first Telegram message, minutes or hours from now.
  if (process.env.ANTHROPIC_API_KEY) {
    ok("ANTHROPIC_API_KEY is set");
    return;
  }
  const hasLogin =
    existsSync(join(homedir(), ".claude", ".credentials.json")) ||
    (() => {
      try {
        execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"],
          { stdio: "ignore" });
        return true;
      } catch { return false; }
    })();

  if (hasLogin) ok("Claude Code is logged in");
  else warn(`No Claude login found. Run ${c.b}claude${c.x} once and sign in, or set ANTHROPIC_API_KEY.`);
}

function checkOptional() {
  const missing = [];
  for (const bin of ["ffmpeg", "whisper"]) {
    if (which(bin)) ok(`${bin} found`);
    else missing.push(bin);
  }
  if (missing.length > 0) {
    warn(`${missing.join(" and ")} not found — voice notes will be handed to Claude as files rather than transcripts.`);
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  say(`\n${c.b}Claude Code Telegram Bridge — setup${c.x}`);
  say(`${c.dim}Nothing is written until you confirm at the end.${c.x}`);

  if (!stdin.isTTY) {
    say(`${c.dim}Reading answers from stdin rather than a terminal.${c.x}`);
  }

  rl = createInterface({ input: stdin, output: stdout });
  watchForInputEnd();
  const existing = readEnvFile(ENV_PATH);
  const TOTAL = 6;

  // 1 --------------------------------------------------------------------
  step(1, TOTAL, "Checking prerequisites");
  checkNode();
  checkClaude();
  checkOptional();

  // 2 --------------------------------------------------------------------
  step(2, TOTAL, "Telegram bot");
  say(`  ${c.dim}In Telegram, message @BotFather and send /newbot.${c.x}`);
  say(`  ${c.dim}It replies with a token like 123456789:AAE….${c.x}\n`);

  let token = existing.TELEGRAM_BOT_TOKEN || "";
  let me = null;
  while (!me) {
    token = await ask("Bot token", { fallback: token, secret: true });
    if (!token) { bad("A token is required."); continue; }
    try {
      me = await telegram(token, "getMe");
    } catch (err) {
      bad(`Telegram rejected that token: ${err.message}`);
      token = "";
    }
  }
  ok(`Connected as @${me.username} (${me.first_name})`);

  // A webhook and getUpdates are mutually exclusive; the bridge polls.
  const hook = await telegram(token, "getWebhookInfo").catch(() => null);
  if (hook?.url) {
    warn(`A webhook is set (${hook.url}); the bridge polls instead.`);
    if (await confirm("Remove the webhook?", true)) {
      await telegram(token, "deleteWebhook");
      ok("Webhook removed");
    }
  }

  // 3 --------------------------------------------------------------------
  step(3, TOTAL, "Group privacy mode");
  // Telegram enables privacy mode by default: the bot then sees only commands
  // and replies in groups, and ignores ordinary messages. Nothing errors, so
  // this is very hard to diagnose after the fact.
  if (me.can_read_all_group_messages) {
    ok("Privacy mode is off — the bot can read group messages");
  } else {
    warn("Privacy mode is ON. In groups your bot will only see /commands,");
    say("    not ordinary messages. It is fine if you only want direct messages.");
    say(`\n    To turn it off: message ${c.b}@BotFather${c.x} → ${c.b}/setprivacy${c.x} → pick`);
    say(`    @${me.username} → ${c.b}Disable${c.x}. Then remove and re-add the bot to any group.\n`);
    if (await confirm("Done that? (checks again)", false)) {
      const again = await telegram(token, "getMe");
      if (again.can_read_all_group_messages) ok("Privacy mode is now off");
      else warn("Still on. Direct messages will work; group messages will not.");
    }
  }

  // 4 --------------------------------------------------------------------
  step(4, TOTAL, "Who may use the bot");
  let allowedUsers = existing.ALLOWED_TELEGRAM_USERS || "";
  say(`  ${c.dim}Sessions run tools without asking, so this allowlist is the${c.x}`);
  say(`  ${c.dim}only thing between a stranger and a shell on this machine.${c.x}\n`);

  if (allowedUsers && !(await confirm(`Replace the current allowlist (${allowedUsers})?`, false))) {
    ok(`Keeping ${allowedUsers}`);
  } else {
    say(`\n  Open Telegram and send @${me.username} any message now.`);
    say(`  ${c.dim}Waiting up to 3 minutes…${c.x}`);
    const msg = await waitForMessage(token, { accept: (m) => m.chat?.type === "private" && m.from?.id });
    if (msg) {
      allowedUsers = String(msg.from.id);
      ok(`Got it: ${msg.from.first_name || "you"} (id ${allowedUsers})`);
    } else {
      warn("No message arrived.");
      allowedUsers = await ask("Your Telegram user id (from @userinfobot)", { fallback: allowedUsers });
      if (!allowedUsers) die("A user id is required.", "Re-run npm run init when you have it.");
    }
  }

  // Optional groups
  let allowedGroups = existing.ALLOWED_TELEGRAM_GROUPS || "";
  const chatNames = {};
  if (await confirm("\n  Add a group chat as well?", false)) {
    const found = [];
    let more = true;
    while (more) {
      say(`\n  Add @${me.username} to the group, then send a message in it.`);
      say(`  ${c.dim}Waiting up to 3 minutes…${c.x}`);
      const msg = await waitForMessage(token, {
        accept: (m) => ["group", "supergroup"].includes(m.chat?.type),
      });
      if (msg) {
        found.push(String(msg.chat.id));
        chatNames[String(msg.chat.id)] = msg.chat.title || `chat-${msg.chat.id}`;
        ok(`"${msg.chat.title}" (id ${msg.chat.id})`);
      } else {
        warn("No group message arrived.");
        if (!me.can_read_all_group_messages) {
          say("    Privacy mode is on, which is very likely why. See step 3.");
        }
      }
      more = await confirm("  Add another group?", false);
    }
    if (found.length > 0) {
      allowedGroups = [...new Set([...allowedGroups.split(",").filter(Boolean), ...found])].join(",");
    }
  }

  // 5 --------------------------------------------------------------------
  step(5, TOTAL, "Workspace and persona");
  say(`  ${c.dim}This directory is where every session runs. Its CLAUDE.md is${c.x}`);
  say(`  ${c.dim}what gives the bot its identity, and its .claude/ supplies skills.${c.x}\n`);

  const cwd = resolve(
    (await ask("Workspace directory", { fallback: existing.CLAUDE_CWD || join(homedir(), "my-assistant") }))
      .replace(/^~(?=\/|$)/, homedir())
  );

  const assistantName = await ask("Assistant name", { fallback: existing.ASSISTANT_NAME || "Claude" });
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timezone = await ask("Timezone", { fallback: existing.BRIDGE_TIMEZONE || systemTz });

  const claudeMd = join(cwd, "CLAUDE.md");
  let scaffold = false;
  if (!existsSync(claudeMd)) {
    scaffold = await confirm(`\n  No CLAUDE.md in ${cwd}. Create a starter one?`, true);
  } else {
    ok(`CLAUDE.md already present in ${cwd}`);
  }

  let yourName = "";
  if (scaffold) yourName = await ask("Your name (for the persona file)", { fallback: "" });

  // 6 --------------------------------------------------------------------
  step(6, TOTAL, "Review");
  const settings = {
    TELEGRAM_BOT_TOKEN: token,
    ALLOWED_TELEGRAM_USERS: allowedUsers,
    ALLOWED_TELEGRAM_GROUPS: allowedGroups,
    CLAUDE_CWD: cwd,
    ASSISTANT_NAME: assistantName,
    BRIDGE_TIMEZONE: timezone,
  };
  if (Object.keys(chatNames).length > 0) settings.CHAT_NAMES = JSON.stringify(chatNames);

  say();
  for (const [k, v] of Object.entries(settings)) {
    if (!v) continue;
    say(`  ${k.padEnd(24)} ${k === "TELEGRAM_BOT_TOKEN" ? mask(v) : v}`);
  }
  say(`\n  Writes ${c.b}.env${c.x} (mode 600)${scaffold ? ` and ${c.b}${claudeMd}${c.x}` : ""}.`);

  if (!(await confirm("\n  Write these?", true))) {
    say("\n  Nothing written. Re-run when ready.\n");
    return;
  }

  if (!existsSync(cwd)) {
    mkdirSync(cwd, { recursive: true });
    ok(`Created ${cwd}`);
  }
  if (scaffold) {
    const template = readFileSync(join(HERE, "CLAUDE.md.example"), "utf8");
    writeFileSync(claudeMd,
      `# ${assistantName}\n\n` +
      `${assistantName}: direct, concise, no filler.\n` +
      `User: ${yourName || "the operator"}, ${timezone}.\n\n` +
      `## Principles\n\n` +
      `- Exhaust local resources (files, scripts, APIs) before asking.\n` +
      `- Confirm before anything leaves the machine: emails, messages, purchases.\n` +
      `- Verify before asserting. Never fabricate. "I don't know" is a fine answer.\n` +
      `- Telegram formatting: no markdown tables. Bold headers and short bullets.\n\n` +
      `## Notes\n\n` +
      `Replace this with what ${assistantName} should know about you and your\n` +
      `setup. Keep it to about one screen: it is prepended to every session.\n\n` +
      `The full template, with more sections to borrow from, is in the bridge\n` +
      `repo as CLAUDE.md.example.\n`);
    ok(`Wrote ${claudeMd}`);
  }
  if (!existsSync(ENV_PATH)) copyFileSync(join(HERE, ".env.example"), ENV_PATH);
  writeEnvFile(ENV_PATH, settings);
  ok(`Wrote ${ENV_PATH}`);

  // Done -----------------------------------------------------------------
  say(`\n${c.b}Ready.${c.x}\n`);
  say(`  Start it:        ${c.b}npm start${c.x}`);
  say(`  Then message @${me.username} on Telegram.\n`);
  say(`  ${c.dim}Only one process may poll a bot token: stop this before${c.x}`);
  say(`  ${c.dim}installing the service, or the two will fight over it.${c.x}\n`);
  say(`  Run at login:    ${c.b}./setup.sh${c.x}   ${c.dim}(macOS launchd)${c.x}`);
  say(`  Scheduled jobs:  ${c.dim}cp cron-jobs.example.mjs cron-jobs.local.mjs${c.x}`);
  say(`  Everything else: ${c.dim}see .env.example and README.md${c.x}\n`);
}

try {
  await main();
} catch (err) {
  if (err instanceof InputEnded) {
    die("Input ended before setup finished.",
        "Run it in a terminal, or pipe in an answer for every question.\n" +
        "  Nothing was written.");
  }
  if (err?.code === "ABORT_ERR" || err?.name === "AbortError") {
    die("Timed out talking to Telegram.", "Check your network and try again.");
  }
  die(err?.message || String(err));
} finally {
  rl?.close();
}
