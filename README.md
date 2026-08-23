# Claude Code Telegram Bridge

Run [Claude Code](https://claude.com/claude-code) as your personal Telegram
bot, with the same skills, MCP servers, and `CLAUDE.md` identity you already
use in the terminal.

Not a thin API wrapper. Sessions load the `claude_code` system-prompt preset
and your filesystem settings, so the bot can read your files, run your
scripts, call your MCP servers, and delegate to your subagents. If the `claude`
CLI can do it in a directory, so can a message.

Same shape as [OpenClaw](https://github.com/openclaw/openclaw): a self-hosted
gateway on your own hardware, reaching you through a chat app you already use.
Different engine. OpenClaw brings its own agent runtime and a dozen channels;
this brings none of that and hands everything to Claude Code, so whatever you
have already built for the CLI works over Telegram on day one.
[Why, and how it works](ARCHITECTURE.md).

```
Telegram  ⇄  bridge.mjs  ⇄  Claude Agent SDK  ⇄  Claude Code
                                                    │
                                              CLAUDE_CWD
                                              ├── CLAUDE.md      identity
                                              └── .claude/       skills, MCP
```

## Install

```bash
git clone https://github.com/hoquem/claude-code-telegram-bridge.git && cd claude-code-telegram-bridge && npm install && npm run init
```

`npm run init` asks you everything it needs and writes the config for you.
Have a bot token ready: message [@BotFather](https://t.me/BotFather), send
`/newbot`, and keep the token it gives you.

Then `npm start`, and message your bot.

[More detail on what the wizard does](#quick-start), or set it up by hand if
you would rather.

## What you get

- **Conversational sessions** that persist across messages, with automatic
  rotation and `/compact` when context grows.
- **Files both ways.** Send a PDF, spreadsheet, or photo and it lands in the
  session. Claude sends files back with an `<outbound_files>` block.
- **Voice notes**, transcribed locally with Whisper. Audio never leaves your
  machine.
- **Scheduled jobs.** Your own cron definitions, each a one-shot Claude
  session with the full tool set. Silent when there's nothing to say.
- **A heartbeat** that checks whatever you tell it to, on a timer, and stays
  quiet unless something needs you.
- **Cost visibility.** Every query logs its model and price; `/costs` breaks
  down the day by model.
- **Model pinning** per chat, per subagent, per job, plus a one-variable
  kill switch to move all traffic to a single model.
- **Resilience worth the name.** Concurrency caps, wall-clock timeouts,
  polling watchdogs, an orphan-subprocess reaper, and a fallback model for
  when the primary is overloaded.
- **A local control API** for driving it from your own dashboard or scripts.

## Requirements

- Node.js 20.12+
- An active Claude Code login, or `ANTHROPIC_API_KEY`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Optional: `ffmpeg` and `whisper` for voice transcription

## Quick start

The install command above runs the wizard. It:

- checks Node, finds Claude Code, and confirms you are actually logged in,
  rather than letting that surface as an opaque error on your first message
- validates your bot token against Telegram live, so a typo fails here and not
  at 3am
- checks **group privacy mode**, which Telegram turns on by default and which
  makes your bot ignore ordinary group messages while looking perfectly
  healthy
- finds your Telegram user id by watching for a message you send it, so you do
  not have to go hunting for it
- finds group ids the same way, if you want group chats
- creates the workspace and a starter `CLAUDE.md`

Nothing is written until you confirm, and re-running it keeps your current
values as defaults, so it is safe to run again to add a group or change the
persona.

### Setting it up by hand

If you would rather not run the wizard, copy `.env.example` to `.env` and set
`TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USERS`, and `CLAUDE_CWD`, then put a
`CLAUDE.md` in that workspace (start from `CLAUDE.md.example`).

There is no default allowlist and the bridge refuses to start without one: a
bot that talks to anybody is a shell anybody can use. It also refuses to start
if `CLAUDE_CWD` does not exist, rather than failing on your first message.

If you plan to use it in group chats, disable privacy mode in
[@BotFather](https://t.me/BotFather): `/setprivacy`, pick your bot, `Disable`,
then remove and re-add it to the group. Otherwise it only sees `/commands`.

### Running it as a service

`npm start` is fine for trying it out. To keep it running across reboots and
crashes on macOS:

```bash
./setup.sh
```

Run it once to create `.env` if you have not already, fill that in, then run
it again to install and start the service. It installs a launchd agent with
`KeepAlive`, so any nonzero exit restarts the bridge. On Linux, write the
equivalent systemd user unit; nothing in the bridge itself is macOS-specific.

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
outage degrades instead of failing. `ANTHROPIC_MODEL_FORCE` suppresses that:
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

The `model:` line is authoritative. Routing lives in the agent definition,
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
side effects and stays silent, but a failure still alerts `CRON_ERROR_CHAT`,
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
response's hash moves, or when `HEARTBEAT_FULL_INTERVAL_MS` forces it.

## Control API

Local HTTP on `127.0.0.1:8091`, for your own dashboards and scripts. Every
`/api/*` route needs `BRIDGE_API_KEY` in an `X-API-Key` header; an unset key
means 401, never "open". `/livez` stays unauthenticated for watchdogs.

```
GET  /livez                 liveness, no auth
GET  /api/status            health + uptime
GET  /api/agents            subagents + session state
GET  /api/crons             jobs with last-run status
POST /api/crons/:id/run     trigger a job (returns immediately; poll /api/crons)
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
your DM with a note saying where it was headed. Cron results and replies are
sent straight through the bot API and never pass the SDK's tool hooks, so this
screen is the only thing standing between a model's text and a group chat.
Choose specific words: a common one will redirect messages you wanted in the
group.

It screens **message text only**. Files sent via an `<outbound_files>` block
go out unscreened and unrestricted by path, so a model that decides to attach
something sensitive will succeed. Given `bypassPermissions` the model is
already trusted with your filesystem, but do not read this guard as a
containment boundary.

## Resilience

Layers, outermost first:

1. **Service manager.** `KeepAlive` restarts on any nonzero exit.
2. **External watchdog.** `scripts/bridge-watchdog.sh` polls `/livez` and
   kickstarts a wedged process.
3. **In-process watchdogs.** Polling staleness (24/7, more tolerant during
   quiet hours), a pending-updates probe, a zombie-EPIPE detector, and an
   orphan SDK-subprocess reaper. Each converts a wedge into a clean exit.
4. **Per-query guards.** Wall-clock timeout, global concurrency semaphore,
   `fallbackModel`, and the SDK stream watchdog.

Every layer logs why it fired. Tuning knobs are in `.env.example`.

## Logs

Default location, or wherever you pointed `LOG_DIR`:

```bash
LOGS=~/.claude-telegram-bridge/logs
tail -f $LOGS/stdout.log
tail -f $LOGS/$(date +%F).jsonl           # structured events
tail -f $LOGS/audit-$(date +%F).jsonl     # costs
```

## Security notes

Sessions run with `bypassPermissions`, so Claude executes tools without asking.
That is what makes the bot useful and what makes the allowlist the only thing
between a stranger and a shell on your machine. Specifically:

- `ALLOWED_TELEGRAM_USERS` is required and has no default.
- Group access needs the chat in `ALLOWED_TELEGRAM_GROUPS` **and** the sender
  in `ALLOWED_TELEGRAM_USERS`.
- The control API binds to loopback only and fails closed without a key.
- Keep `.env` at mode 600. Never put the bot token in the launchd plist:
  plists are world-readable.
- The control API sends no CORS headers unless you set `API_CORS_ORIGIN`.
- Outbound file sends are not path-restricted. See the guard section above.

## Contributing

Issues and pull requests welcome. CI runs the test suite on Node 20.12, 22,
and 24, and parses every module and script; `npm test` locally should match.
Please keep
per-deployment values (chat ids, paths, prompts) out of source files; they
belong in `config.mjs` reading from the environment. `CLAUDE.md` has the
design intents worth preserving.

## Licence

MIT
