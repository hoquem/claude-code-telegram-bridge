/**
 * In-process cron scheduler.
 *
 * Jobs are your own: point CRON_JOBS_FILE at a module that default-exports an
 * array of them. Nothing is scheduled until you do. See cron-jobs.example.mjs
 * for the shape and the available fields.
 *
 * Each job runs as a one-shot Claude Agent SDK session in the bridge's
 * workspace, with the same subagents, tool set, and resilience guards
 * interactive chats get.
 */

import cron from "node-cron";
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { join, resolve as resolvePath } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.mjs";
import { trackCost, auditLog } from "./hooks.mjs";
import { pickModel, fallbackModelFor, usedPrimaryModel } from "./models.mjs";
import { agents } from "./agents.mjs";
import { sdkResilienceEnv, querySemaphore } from "./resilience.mjs";

// These are injected at startup to avoid circular imports
let log = (level, msg, meta) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
let sendLongMessage = async () => {};

export function setCronDeps(deps) {
  log = deps.log;
  sendLongMessage = deps.sendLongMessage;
}

const ALL_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"];
const activeCronJobs = new Map();
const runningJobs = new Set();
const jobRunHistory = new Map(); // jobId -> { lastRun: ms, lastStatus: 'success'|'failed', durationMs, retryCount }

// Default timeout: 10 minutes. Jobs with effort: "high" get 20 minutes.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const HIGH_EFFORT_TIMEOUT_MS = 20 * 60 * 1000;

// Ceiling on what a single job may spend before the SDK stops it. Generous
// enough for a genuinely complex job, low enough that a runaway loop shows up
// as a failed job rather than a surprise on the bill.
const MAX_JOB_BUDGET_USD = Number(process.env.CRON_MAX_BUDGET_USD) || 5.0;

// Final-failure alerts always go here, regardless of job.deliverTo — so a
// silent job (deliverTo: null) can't fail quietly.
const ERROR_CHANNEL = config.cronErrorChat;

// ---------------------------------------------------------------------------
// Job definitions, loaded from CRON_JOBS_FILE at startup.
// ---------------------------------------------------------------------------

/** Populated by loadCronJobs(); empty until then. */
export let jobs = [];

/**
 * Load and validate the job definitions named by CRON_JOBS_FILE.
 *
 * :returns: The loaded jobs. Empty when no file is configured.
 */
export async function loadCronJobs(file = config.cronJobsFile) {
  if (!file) {
    log("info", "cron-jobs-none-configured", {
      hint: "Set CRON_JOBS_FILE to schedule jobs. See cron-jobs.example.mjs.",
    });
    jobs = [];
    return jobs;
  }

  const path = resolvePath(file.replace(/^~(?=\/|$)/, homedir()));
  let loaded;
  try {
    const mod = await import(pathToFileURL(path).href);
    loaded = mod.default ?? mod.jobs;
  } catch (err) {
    // A configured-but-unloadable jobs file is a deployment error, not a
    // reason to start up quietly with no schedule.
    log("error", "cron-jobs-load-failed", { path, error: err.message });
    throw new Error(`CRON_JOBS_FILE could not be loaded (${path}): ${err.message}`);
  }

  if (!Array.isArray(loaded)) {
    throw new Error(`CRON_JOBS_FILE (${path}) must default-export an array of jobs`);
  }

  const seen = new Set();
  for (const job of loaded) {
    if (!job?.id || !job?.schedule || !job?.prompt) {
      throw new Error(`CRON_JOBS_FILE (${path}): every job needs id, schedule, and prompt — got ${JSON.stringify(job)?.slice(0, 120)}`);
    }
    if (seen.has(job.id)) {
      throw new Error(`CRON_JOBS_FILE (${path}): duplicate job id "${job.id}"`);
    }
    seen.add(job.id);
  }

  jobs = loaded;
  log("info", "cron-jobs-loaded", { path, count: jobs.length });
  return jobs;
}

/**
 * Pick the model tier for a cron job.
 *
 * :param jobId: Job id, used only to attribute a warning about a bad value.
 * :param jobModel: The job's ``model`` field: a tier name, a full model id,
 *   or nothing at all (meaning the default tier).
 * :returns: Model id.
 */
export function pickModelForCron(jobId, jobModel = null) {
  return pickModel(jobModel, `cron job "${jobId}"`, (msg) => log("warn", "cron-model-unrecognized", { jobId, message: msg }));
}

// ---------------------------------------------------------------------------
// Quiet-hours alert queue.
//
// Failure alerts from night jobs, and any cron output destined for the
// operator's DM, would otherwise buzz a phone at 03:00. During quiet hours
// they append to a file instead and flush shortly after quiet hours end.
// Group-destined content is unaffected: groups can be muted client-side, and
// a briefing posted to a muted group at 02:00 wakes nobody.
// ---------------------------------------------------------------------------

const ALERT_QUEUE_FILE = join(config.stateDir, "queued-alerts.jsonl");

function isQuietHoursNow() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: config.timezone }));
  const hour = now.getHours();
  if (config.quietStart > config.quietEnd) {
    return hour >= config.quietStart || hour < config.quietEnd;
  }
  return hour >= config.quietStart && hour < config.quietEnd;
}

/** Send now, or queue for the post-quiet-hours flush when it would ping overnight. */
async function sendOrQueue(chatId, text, { isAlert = false } = {}) {
  const dmDestined = String(chatId) === String(config.defaultChatId);
  if (isQuietHoursNow() && (isAlert || dmDestined)) {
    appendFileSync(ALERT_QUEUE_FILE, JSON.stringify({ ts: new Date().toISOString(), chatId, text }) + "\n");
    log("info", "cron-alert-queued", { chatId, isAlert, textLen: text.length });
    return;
  }
  await sendLongMessage(Number(chatId), text);
}

async function flushAlertQueue() {
  if (!existsSync(ALERT_QUEUE_FILE)) return;
  let lines;
  try {
    lines = readFileSync(ALERT_QUEUE_FILE, "utf8").split("\n").filter(Boolean);
    unlinkSync(ALERT_QUEUE_FILE);
  } catch (err) {
    log("error", "alert-queue-read-failed", { error: err.message });
    return;
  }
  if (!lines.length) return;
  log("info", "alert-queue-flush", { count: lines.length });
  for (const line of lines) {
    try {
      const { ts, chatId, text } = JSON.parse(line);
      await sendLongMessage(Number(chatId), `\u{1F319} *Queued overnight (${ts.slice(11, 16)} UTC):*\n\n${text}`);
    } catch (err) {
      log("error", "alert-queue-item-failed", { error: err.message });
    }
  }
}

// ---------------------------------------------------------------------------
// HEARTBEAT_OK suppression patterns
// ---------------------------------------------------------------------------

const OK_PATTERNS = [
  /^heartbeat[_ ]?ok$/i,
  /^no[_ ]?action/i,
  /^nothing[_ ]?to[_ ]?report/i,
  /^all[_ ]?clear/i,
  /^no[_ ]?alerts?/i,
];

function shouldSuppress(text, job) {
  if (!text || text.trim().length === 0) return true;
  if (!job.suppressOk) return false;
  const firstLine = text.trim().split("\n")[0].trim();
  return OK_PATTERNS.some((p) => p.test(firstLine));
}

// ---------------------------------------------------------------------------
// Execute a cron job
// ---------------------------------------------------------------------------

/**
 * Run a single attempt of a cron job with timeout protection.
 * Returns { resultText, cost, turns } on success, throws on failure.
 */
async function runCronJobOnce(job) {
  // Subprocess-slot discipline shared with interactive queries + heartbeat —
  // a cron burst can no longer stack unbounded ~300 MB SDK subprocesses.
  // Acquired before the timeout is armed so queue-wait doesn't eat the
  // job's execution budget. The wait is unbounded (scheduled jobs should run
  // late rather than not at all), so a long queue delay must be visible:
  // a briefing delivered an hour past its cron time needs a log explaining why.
  const queueWaitStart = Date.now();
  await querySemaphore.acquire();
  const queueWaitMs = Date.now() - queueWaitStart;
  if (queueWaitMs > 60_000) {
    log("warn", `cron-queue-delay: ${job.id}`, {
      queueWaitMs,
      active: querySemaphore.active,
      queued: querySemaphore.queued,
    });
  }

  const timeoutMs = job.timeoutMs || (job.effort === "high" ? HIGH_EFFORT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

  // Warn if job is taking too long (at 80% of timeout)
  const warnHandle = setTimeout(() => {
    log("warn", `cron-slow: ${job.id}`, {
      elapsedMs: Math.round(timeoutMs * 0.8),
      timeoutMs,
      message: `Job approaching timeout (80% of ${Math.round(timeoutMs / 1000)}s)`,
    });
  }, timeoutMs * 0.8);

  let resultText = "";
  let cost = 0;
  let turns = 0;
  let modelsUsed = [];

  // A job may write its prompt as an array of lines for readability.
  const promptText = Array.isArray(job.prompt) ? job.prompt.join("\n") : job.prompt;

  const model = pickModelForCron(job.id, job.model);

  try {
    for await (const message of query({
      prompt: promptText,
      options: {
        cwd: config.cwd,
        // BRIDGE_DELIVER_TO tells the session where its output is headed, so
        // hooks in the workspace can make destination-aware decisions (e.g. a
        // PreToolUse hook refusing to read private files for a group-bound
        // job). Empty string = a silent job with no external output.
        // sdkResilienceEnv: stream watchdog + transport retries.
        env: { ...process.env, ...sdkResilienceEnv(), BRIDGE_DELIVER_TO: job.deliverTo != null ? String(job.deliverTo) : "" },
        // Same subagent roster interactive sessions get, so a job whose prompt
        // delegates to an agent gets that agent's own model and tools.
        agents,
        allowedTools: ALL_TOOLS,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: job.maxTurns || 20,
        effort: job.effort || "medium",
        maxBudgetUsd: MAX_JOB_BUDGET_USD,
        persistSession: false,
        abortController,
        model,
        // Fallback tier if the primary model errors (overload/outage) —
        // scheduled jobs should degrade to an adjacent model, not fail.
        // Never set under ANTHROPIC_MODEL_FORCE ("ALL traffic on this model").
        ...(config.modelForce ? {} : { fallbackModel: fallbackModelFor(model, config) }),
        stderr: (chunk) => log("error", "claude-stderr", { source: "cron", jobId: job.id, chunk: String(chunk).trim() }),
      },
    })) {
      // Fallback engagement must never be silent (same rule as runClaude).
      if (message.type === "system" && message.subtype === "model_refusal_fallback") {
        log("warn", "model-fallback-engaged", {
          source: "cron",
          jobId: job.id,
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
  } finally {
    clearTimeout(timeoutHandle);
    clearTimeout(warnHandle);
    querySemaphore.release();
  }

  if (modelsUsed.length > 0 && !usedPrimaryModel(model, modelsUsed)) {
    log("warn", "primary-model-not-used", { source: "cron", jobId: job.id, routed: model, modelsUsed });
  }

  return { resultText, cost, turns, model, modelsUsed };
}

async function executeCronJob(job) {
  if (runningJobs.has(job.id)) {
    log("info", `cron-skip: ${job.id} already running`);
    return;
  }

  runningJobs.add(job.id);
  const startTime = Date.now();
  const maxRetries = job.maxRetries || 0;
  const retryDelayMs = job.retryDelayMs || 60_000;

  log("info", `cron-start: ${job.id}`, { maxRetries });
  auditLog("cron-start", { jobId: job.id, maxRetries });

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      log("info", `cron-retry: ${job.id}`, { attempt, of: maxRetries, delayMs: retryDelayMs });
      auditLog("cron-retry", { jobId: job.id, attempt });
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }

    try {
      const { resultText, cost, turns, model, modelsUsed } = await runCronJobOnce(job);

      const durationMs = Date.now() - startTime;
      const suppressed = shouldSuppress(resultText, job);

      log("info", `cron-done: ${job.id}`, {
        durationMs, cost, turns, suppressed, attempt,
        responseLen: resultText.length,
        model, modelsUsed,
      });
      trackCost("cron", cost, { jobId: job.id });
      auditLog("cron-done", { jobId: job.id, durationMs, cost, turns, suppressed, attempt });

      jobRunHistory.set(job.id, {
        lastRun: Date.now(), lastStatus: "success", durationMs, retryCount: attempt,
      });

      // Deliver to Telegram if there's a target and content
      if (job.deliverTo && resultText.trim().length > 0 && !suppressed) {
        await sendOrQueue(job.deliverTo, resultText);
        log("info", `cron-delivered: ${job.id}`, { chatId: job.deliverTo });
      } else if (job.deliverTo && resultText.trim().length === 0) {
        // A deliverable job that returned nothing on a soft (non-thrown)
        // failure used to vanish silently. shouldSuppress() treats empty as
        // suppressed for everyone, and the thrown-error alert path below never
        // fired. Surface it so silent soft-failures don't die quietly.
        log("warn", `cron-empty-result: ${job.id}`, {
          durationMs, turns, attempt, deliverTo: job.deliverTo,
        });
        auditLog("cron-empty-result", { jobId: job.id, durationMs, turns, attempt });
        if (ERROR_CHANNEL) {
          try {
            await sendOrQueue(ERROR_CHANNEL,
              `⚠️ *Cron returned no output: ${job.id}*\nDuration: ${Math.round(durationMs / 1000)}s\nTurns: ${turns}\nThe model produced an empty result (soft failure). Check logs.`,
              { isAlert: true });
          } catch { /* don't cascade a Telegram failure */ }
        }
      }

      runningJobs.delete(job.id);
      return; // Success — exit retry loop
    } catch (err) {
      lastError = err;
      const isTimeout = err.name === "AbortError";
      log("error", `cron-error: ${job.id}`, {
        error: err.message, attempt, isTimeout,
        durationMs: Date.now() - startTime,
      });
      auditLog("cron-error", { jobId: job.id, error: err.message, attempt, isTimeout });
    }
  }

  // All attempts exhausted
  const durationMs = Date.now() - startTime;
  jobRunHistory.set(job.id, {
    lastRun: Date.now(), lastStatus: "failed", durationMs, retryCount: maxRetries,
  });

  if (lastError) {
    const alertText = `*❌ Cron failed: ${job.id}*\nAttempts: ${maxRetries + 1}\nDuration: ${Math.round(durationMs / 1000)}s\nError: ${lastError.message}`;

    // Always alert the error channel so silent jobs (deliverTo: null) don't fail quietly.
    if (ERROR_CHANNEL) {
      try {
        await sendOrQueue(ERROR_CHANNEL, alertText, { isAlert: true });
      } catch { /* don't cascade a Telegram failure */ }
    }

    // Also notify the job's own deliverTo, unless it's the same channel (avoid double-ping).
    if (job.deliverTo && String(job.deliverTo) !== String(ERROR_CHANNEL)) {
      try {
        await sendOrQueue(job.deliverTo, alertText, { isAlert: true });
      } catch { /* don't cascade */ }
    }
  }

  runningJobs.delete(job.id);
}

// ---------------------------------------------------------------------------
// Start/stop the cron scheduler
// ---------------------------------------------------------------------------

export async function startCronScheduler() {
  await loadCronJobs();
  let scheduled = 0;

  for (const job of jobs) {
    // Validate cron expression
    if (!cron.validate(job.schedule)) {
      log("warn", `cron-invalid-schedule: ${job.id}`, { schedule: job.schedule });
      continue;
    }

    const task = cron.schedule(job.schedule, () => executeCronJob(job), {
      timezone: job.tz || config.timezone,
    });

    activeCronJobs.set(job.id, { task, job });
    scheduled++;
  }

  // Flush the quiet-hours queue 5 minutes after quiet hours end, and again on
  // startup if we're already past that point (the bridge may have restarted).
  cron.schedule(`5 ${config.quietEnd} * * *`, () => flushAlertQueue(), { timezone: config.timezone });
  if (!isQuietHoursNow()) flushAlertQueue();

  log("info", "cron-scheduler-start", { totalJobs: scheduled });
  return scheduled;
}

export function stopCronScheduler() {
  for (const [id, { task }] of activeCronJobs) {
    task.stop();
  }
  log("info", "cron-scheduler-stop", { stoppedJobs: activeCronJobs.size });
  activeCronJobs.clear();
}

export function listCronJobs() {
  return jobs.map((j) => {
    const history = jobRunHistory.get(j.id);
    return {
      id: j.id,
      schedule: j.schedule,
      tz: j.tz,
      deliverTo: j.deliverTo,
      running: runningJobs.has(j.id),
      lastRun: history?.lastRun || null,
      lastStatus: history?.lastStatus || null,
    };
  });
}

/** Is there a job with this id? Lets a caller 404 without running anything. */
export function hasCronJob(jobId) {
  return activeCronJobs.has(jobId) || jobs.some((j) => j.id === jobId);
}

/**
 * Manually trigger a cron job by ID.
 */
export async function triggerCronJob(jobId) {
  const entry = activeCronJobs.get(jobId);
  if (entry) {
    await executeCronJob(entry.job);
    return true;
  }
  // Fallback: look up in jobs array (handles jobs that failed cron.validate)
  const job = jobs.find((j) => j.id === jobId);
  if (job) {
    await executeCronJob(job);
    return true;
  }
  return null;
}
