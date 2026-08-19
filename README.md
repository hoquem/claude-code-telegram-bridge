# Claude Code Telegram Bridge

Run [Claude Code](https://claude.com/claude-code) as your personal Telegram
bot — with the same skills, MCP servers, and `CLAUDE.md` identity you already
use in the terminal.

Not a thin API wrapper. Sessions load the `claude_code` system-prompt preset
and your filesystem settings, so the bot can read your files, run your
scripts, call your MCP servers, and delegate to your subagents. If the `claude`
CLI can do it in a directory, so can a message.

```
Telegram  ⇄  bridge.mjs  ⇄  Claude Agent SDK  ⇄  Claude Code
                                                    │
                                              CLAUDE_CWD
                                              ├── CLAUDE.md      identity
                                              └── .claude/       skills, MCP
```

## What you get

- **Conversational sessions** that persist across messages, with automatic
  rotation and `/compact` when context grows.
- **Files both ways.** Send a PDF, spreadsheet, or photo and it lands in the
  session. Claude sends files back with an `<outbound_files>` block.
- **Voice notes**, transcribed locally with Whisper — audio never leaves your
  machine.
- **Scheduled jobs.** Your own cron definitions, each a one-shot Claude
  session with the full tool set. Silent when there's nothing to say.
- **A heartbeat** that checks whatever you tell it to, on a timer, and stays
  quiet unless something needs you.
- **Cost visibility.** Every query logs its model and price; `/costs` breaks
  down the day by model.
- **Model pinning** per chat, per subagent, per job — plus a one-variable
  kill switch to move all traffic to a single model.
- **Resilience worth the name.** Concurrency caps, wall-clock timeouts,
  polling watchdogs, an orphan-subprocess reaper, and a fallback model for
  when the primary is overloaded.
- **A local control API** for driving it from your own dashboard or scripts.

## Requirements

- Node.js 20+
- An active Claude Code login, or `ANTHROPIC_API_KEY`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Optional: `ffmpeg` and `whisper` for voice transcription

## Quick start

```bash
git clone https://github.com/hoquem/claude-code-telegram-bridge.git
cd claude-code-telegram-bridge
npm install

cp .env.example .env
```

Fill in the two required values in `.env`:

```bash
TELEGRAM_BOT_TOKEN=...        # from @BotFather
ALLOWED_TELEGRAM_USERS=...    # your user ID, from @userinfobot
```

There is no default allowlist and the bridge won't start without one — a bot
that talks to anybody is a shell anybody can use.

Then give it a workspace:

```bash
mkdir -p ~/my-assistant
cp CLAUDE.md.example ~/my-assistant/CLAUDE.md   # edit this
echo 'CLAUDE_CWD=/Users/you/my-assistant' >> .env

npm start
```

Message your bot. That's the whole setup — everything below is optional.

### Running it as a service

`npm start` is fine for trying it out. To keep it running across reboots and
crashes on macOS:

```bash
./setup.sh
```

That installs a launchd agent with `KeepAlive`, so any nonzero exit restarts
the bridge. On Linux, write the equivalent systemd user unit — nothing in the
bridge itself is macOS-specific.

For a second layer, run `scripts/bridge-watchdog.sh` on a 60-second interval.
It polls `/livez` and force-restarts a wedged process that the in-process
watchdogs couldn't recover.

## Telegram commands

| Command | |
|---|---|
| `/start` | check the bot is alive |
| `/help` | list commands |
| `/reset` | start a fresh conversation |
| `/cancel` | cancel the in-flight query |
| `/compact` | summarize old context, keep the conversation going |
| `/status` | session, model/effort pins, query slots, daily cost |
| `/model [fable\|sonnet\|haiku\|auto]` | pin the model for this chat |
| `/effort [low…max\|auto]` | pin reasoning effort for this chat |
| `/costs` | daily cost breakdown by type and model |
| `/heartbeat` | run the heartbeat now |
| `/cron`, `/run_JOB_ID` | list and trigger scheduled jobs |

## Model routing

There is no prompt classifier. A model comes from an explicit pin or from the
default tier:

| | Precedence |
|---|---|
| Interactive chat | `ANTHROPIC_MODEL_FORCE` → `/model` pin → default tier |
| Subagent | the agent file's `model:` frontmatter → default tier |
| Cron job | `ANTHROPIC_MODEL_FORCE` → job's `model` field → default tier |

Tier names (`fable`, `sonnet`, `haiku`) map to model ids you set in `.env`, so
a new model release is a config change. An unrecognized tier logs a warning
naming the file or job that carried it, rather than quietly running on
something else.

Every query also carries an adjacent-tier `fallbackModel`, so a primary-model
outage degrades instead of failing. `ANTHROPIC_MODEL_FORCE` suppresses that —
its contract is *all* traffic on exactly one model.

## Subagents

Any Claude Code subagent definition in `~/.claude/agents/` (or `AGENTS_DIR`)
is available for delegation. The bridge reads the standard format:

```markdown
---
name: researcher
description: Deep research, papers, technical background
tools: Read, Grep, WebFetch, WebSearch
model: fable
---

You are a research specialist. ...
```

The `model:` line is authoritative — routing lives in the agent definition,
not in bridge code.

## Scheduled jobs

Copy the example, edit it, point at it:

```bash
cp cron-jobs.example.mjs cron-jobs.local.mjs
echo 'CRON_JOBS_FILE=./cron-jobs.local.mjs' >> .env
```

```javascript
export default [
  {
    id: "morning-briefing",
    schedule: "30 7 * * 1-5",
    deliverTo: "-1001234567890",
    model: "fable",
    effort: "high",
    prompt: "Calendar for today, mail needing a reply, weather. Short bullets.",
  },
  {
    id: "disk-check",
    schedule: "0 * * * *",
    deliverTo: "123456789",
    model: "haiku",
    suppressOk: true,     // stay silent when there's nothing to report
    prompt: "Run df -h /. Above 85%, report it. Otherwise reply HEARTBEAT_OK.",
  },
];
```

`cron-jobs.local.mjs` is gitignored. A job with `deliverTo: null` runs for its
side effects and stays silent — but a failure still alerts `CRON_ERROR_CHAT`,
so nothing dies quietly. See `cron-jobs.example.mjs` for every field.

## Heartbeat

A periodic "anything I should know about?" Write the checklist yourself:

```bash
cat > heartbeat.md <<'EOF'
- Unread mail marked important in the last 4 hours.
- Anything on the calendar in the next 12 hours.
- Whether the build on main is green.
EOF
echo 'HEARTBEAT_PROMPT_FILE=./heartbeat.md' >> .env
```

The bridge adds the reporting contract, including the `HEARTBEAT_OK` reply
that keeps a quiet run silent. Disabled entirely when unset.

An LLM check on a short interval is the easiest way to spend money on an idle
system, so there's a pre-filter: set `HEARTBEAT_PROBE_URL` to something cheap
that changes when your world changes, and the model only runs when that
response's hash moves — or when `HEARTBEAT_FULL_INTERVAL_MS` forces it.

## Control API

Local HTTP on `127.0.0.1:8091`, for your own dashboards and scripts. Every
`/api/*` route needs `BRIDGE_API_KEY` in an `X-API-Key` header; an unset key
means 401, never "open". `/livez` stays unauthenticated for watchdogs.

```
GET  /livez                 liveness, no auth
GET  /api/status            health + uptime
GET  /api/agents            subagents + session state
GET  /api/crons             jobs with last-run status
POST /api/crons/:id/run     trigger a job
GET  /api/costs             daily + 7-day cost trend
POST /api/dispatch          {prompt, chat_id?, deliver?}
```

`/api/dispatch` runs arbitrary prompts with `bypassPermissions`. Treat the key
like a shell credential.

## Keeping secrets out of chats

If some topic must never reach a group chat, name it:

```bash
SENSITIVE_KEYWORDS=projectx,acquisition
SENSITIVE_REDIRECT_CHAT=123456789
```

An outbound message matching one of those on a word boundary is redirected to
your DM with a note saying where it was headed. This is the only enforcement
point for outbound content — cron results and replies are sent straight
through the bot API and never pass the SDK's tool hooks. Choose specific
words: a common one will redirect messages you wanted in the group.

## Resilience

Layers, outermost first:

1. **Service manager** — `KeepAlive` restarts on any nonzero exit.
2. **External watchdog** — `scripts/bridge-watchdog.sh` polls `/livez` and
   kickstarts a wedged process.
3. **In-process watchdogs** — polling staleness (24/7, more tolerant during
   quiet hours), a pending-updates probe, a zombie-EPIPE detector, and an
   orphan SDK-subprocess reaper. Each converts a wedge into a clean exit.
4. **Per-query guards** — wall-clock timeout, global concurrency semaphore,
   `fallbackModel`, and the SDK stream watchdog.

Every layer logs why it fired. Tuning knobs are in `.env.example`.

## Logs

```bash
tail -f ~/.claude-telegram-bridge/logs/stdout.log
tail -f ~/.claude-telegram-bridge/logs/$(date +%F).jsonl     # structured
tail -f ~/.claude-telegram-bridge/logs/audit-$(date +%F).jsonl  # costs
```

## Security notes

Sessions run with `bypassPermissions` — Claude executes tools without asking.
That is what makes the bot useful and what makes the allowlist the only thing
between a stranger and a shell on your machine. Specifically:

- `ALLOWED_TELEGRAM_USERS` is required and has no default.
- Group access needs the chat in `ALLOWED_TELEGRAM_GROUPS` **and** the sender
  in `ALLOWED_TELEGRAM_USERS`.
- The control API binds to loopback only and fails closed without a key.
- Keep `.env` at mode 600. Never put the bot token in the launchd plist —
  plists are world-readable.

## Contributing

Issues and pull requests welcome. `npm test` should pass, and please keep
per-deployment values (chat ids, paths, prompts) out of source files — they
belong in `config.mjs` reading from the environment. `CLAUDE.md` has the
design intents worth preserving.

## Licence

MIT
