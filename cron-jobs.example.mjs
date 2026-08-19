/**
 * Example cron job definitions.
 *
 * Copy this to a file of your own, edit it, and point CRON_JOBS_FILE at it:
 *
 *     cp cron-jobs.example.mjs cron-jobs.local.mjs
 *     echo 'CRON_JOBS_FILE=./cron-jobs.local.mjs' >> .env
 *
 * Then replace every REPLACE_WITH_CHAT_ID below with a real chat id. A job
 * with no deliverTo runs silently, which looks identical to a job that isn't
 * running at all.
 *
 * cron-jobs.local.mjs is gitignored, so your schedule and prompts stay out of
 * version control.
 *
 * Each job runs as a one-shot Claude session in CLAUDE_CWD with the full tool
 * set, so a prompt can read files, run scripts, and call MCP servers.
 *
 * Fields
 * ------
 * id            Unique, stable. Used by /run_<id>, the API, and logs.
 * schedule      Five-field cron expression.
 * tz            IANA timezone for this job. Defaults to BRIDGE_TIMEZONE.
 * prompt        String, or an array of lines joined with newlines.
 * deliverTo     Chat id to send the result to. null = silent job (run for
 *               its side effects; failures still alert CRON_ERROR_CHAT).
 * model         "haiku" | "sonnet" | "fable", or a full claude-* model id.
 *               Omit for the default tier.
 * effort        "low" | "medium" | "high" | "xhigh" | "max". Default "medium".
 *               "high" and above also raise the job timeout to 20 minutes.
 * maxTurns      Agent turn cap. Default 20. Raise for multi-step jobs.
 * timeoutMs     Explicit wall-clock cap, overriding the effort-derived one.
 * maxRetries    Retries on failure. Default 0.
 * retryDelayMs  Wait between retries. Default 60000.
 * suppressOk    When true, a result whose first line reads as "nothing to
 *               report" is not delivered. Use for jobs that should only
 *               speak up when something is wrong.
 *
 * Writing good job prompts
 * ------------------------
 * Say what to do, what to report, and what to do on failure. A job that
 * silently returns nothing when its data source is down is worse than one
 * that says the source is down: the engine surfaces empty results, but only
 * the prompt can explain them.
 */

export default [
  {
    id: "morning-briefing",
    schedule: "30 7 * * 1-5",
    deliverTo: "REPLACE_WITH_CHAT_ID",   // e.g. "-1001234567890" or your user id
    effort: "high",
    maxTurns: 30,
    prompt: [
      "Produce the morning briefing.",
      "1. Today's calendar: anything in the next 12 hours.",
      "2. Unread mail that looks like it needs a reply today.",
      "3. Weather where I am.",
      "Format as short Telegram bullets with bold headers. No tables.",
      "If a source is unavailable, say which one and carry on with the rest.",
    ],
  },

  {
    id: "disk-space-check",
    schedule: "0 * * * *",
    deliverTo: "REPLACE_WITH_CHAT_ID",
    model: "haiku",
    maxTurns: 5,
    suppressOk: true,
    prompt:
      "Run `df -h /`. If the root volume is above 85% used, report the " +
      "percentage and the three largest directories under my home folder. " +
      "Otherwise reply with exactly HEARTBEAT_OK and nothing else.",
  },

  {
    id: "weekly-repo-digest",
    schedule: "0 18 * * 5",
    deliverTo: "REPLACE_WITH_CHAT_ID",
    model: "fable",
    effort: "high",
    maxTurns: 40,
    maxRetries: 1,
    prompt: [
      "Summarise this week's activity across my active git repositories.",
      "For each: commits landed, open PRs awaiting review, and anything that",
      "looks stalled (a branch with no commits for over two weeks).",
      "Lead with what needs my attention. Keep it under 20 lines.",
      "If a repository can't be read, name it and continue.",
    ],
  },

  {
    id: "nightly-backup",
    schedule: "0 2 * * *",
    // Silent: this job exists for its side effect. If it throws, the engine
    // still alerts CRON_ERROR_CHAT.
    deliverTo: null,
    model: "haiku",
    maxTurns: 5,
    maxRetries: 2,
    retryDelayMs: 300000,
    prompt:
      "Run the backup script at ~/scripts/backup.sh. If the exit code is " +
      "non-zero, report the last 20 lines of its output. Otherwise stay silent.",
  },
];
