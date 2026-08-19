# Why this exists, and how it works

## The problem

Claude Code is the most capable thing on your machine. It reads your files,
runs your scripts, drives your MCP servers, follows the instructions in your
`CLAUDE.md`, and delegates to subagents you wrote. And it is stuck behind a
terminal on a desk you are not sitting at.

Most of what you actually want from an assistant happens away from that desk.
A tenant emails while you are on a train. You want yesterday's numbers during
a meeting. Something breaks at 2am and you would like to be told, rather than
to discover it on Monday. None of that reaches a terminal.

So you want your assistant in a chat app. That is the problem
[OpenClaw](https://github.com/openclaw/openclaw) named clearly and solved at
scale: a self-hosted gateway on your own hardware, connected to WhatsApp,
Telegram, Signal, Discord and a dozen more, with your context staying on your
machine instead of somebody's cloud. It is a genuinely good design, and the
reason this project's shape looks familiar is that the shape is right.

The difference is what sits behind the gateway. OpenClaw brings its own agent
runtime, with its own way of managing sessions, tools, and memory. This
project brings none of that. It is a thin bridge whose entire job is to hand
a Telegram message to **Claude Code** and hand the answer back.

That trade is deliberate. Fewer channels, no agent runtime of its own, no
memory system, no tool framework. In exchange, everything you have already
built for Claude Code works over Telegram on the day you install it, with no
porting and no second configuration to keep in sync.

## What "Claude Code as the engine" actually buys

The claim is parity: a Telegram session should be able to do what `claude` can
do in the same directory. Two options make that true, and they are the two
worth protecting across SDK upgrades ([`bridge.mjs`](bridge.mjs)):

```javascript
systemPrompt: { type: "preset", preset: "claude_code" },
settingSources: ["user", "project"],
```

The first gives the session Claude Code's own system prompt rather than a bare
API persona. The second makes it read the filesystem the way the CLI does.
Together they mean everything below comes for free rather than being
reimplemented.

**Your `CLAUDE.md` is the assistant's identity.** Not a prompt string in this
repo's source: the file in your workspace. Edit it and the next message
behaves differently. The bridge has no persona of its own.

**Your skills load.** Anything in the workspace's `.claude/skills/` is
available. A skill you wrote for the terminal works from your phone,
unchanged.

**Your MCP servers connect.** Gmail, Calendar, Drive, a database, an internal
API: whatever the CLI can reach in that directory, a Telegram message can
reach. This is where most of the practical power comes from, and the bridge
contributes nothing to it beyond not getting in the way.

**Your subagents work, with their own models.** Any Claude Code agent
definition in `~/.claude/agents/` is loaded and offered to the session
([`agents.mjs`](agents.mjs)). The `model:` line in an agent's frontmatter is
authoritative, so a reasoning-heavy researcher can run on a stronger model
than a quick-lookup helper, decided in the agent file rather than in bridge
code.

**The full tool set.** `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`,
`WebFetch`, `WebSearch`, and `Agent`. Real work on real files, not a chatbot
that can only talk.

**Sessions persist and resume.** The SDK's `resume` plus a session store on
disk means a conversation survives restarts, and `/compact` runs the CLI's own
compaction inside the live session instead of throwing the context away.

**You see it working.** `includePartialMessages` streams the assistant's draft
and its tool calls, which [`progress.mjs`](progress.mjs) turns into a Telegram
message that updates as it goes. A five-minute task shows its working rather
than looking hung.

**Reasoning effort is a dial.** `/effort low` through `/effort max`, per chat.

**Cost is visible per query.** Every result carries `total_cost_usd`, logged
against the model that ran and summarised by `/costs`. Scheduled jobs also get
`maxBudgetUsd`, so a runaway job is a failed job rather than a surprise on the
bill.

**Outages degrade instead of failing.** Every query carries an adjacent-tier
`fallbackModel`; when the primary is overloaded the SDK retries on the
neighbour and the bridge logs that it happened.

## Architecture

One Node process. No database, no broker, no container.

```
              ┌──────────────────────────────────────────────┐
  Telegram ──▶│  bridge.mjs                                  │
   (poll)     │                                              │
              │  auth ▸ session ▸ model ▸ query ▸ progress    │
              │    │                          │              │
              │    │                          ▼              │
              │    │              Claude Agent SDK           │
              │    │                          │              │
              │    │              ┌───────────▼───────────┐  │
              │    │              │  claude subprocess    │  │
              │    │              │  ~300 MB, per query   │  │
              │    │              └───────────┬───────────┘  │
              │    │                          │              │
              │  cron-jobs.mjs                ▼              │
              │  heartbeat            CLAUDE_CWD             │
              │  api-server.mjs       ├── CLAUDE.md          │
              │                       └── .claude/           │
              └──────────────────────────────────────────────┘
                                       skills, MCP servers
```

**A message's path.** Telegram long-poll delivers it. `isAuthorized` checks
the allowlist and drops anything else. Files are downloaded and voice notes
transcribed locally. The chat's session id is looked up, and rotated if it has
grown expensive. A model is chosen from the chat's pin or the default tier. A
semaphore slot is acquired, since each query is a ~300 MB subprocess and they
have to be capped. The query streams; the progress message updates. The result is
screened for sensitive keywords, split into 4096-character chunks, and sent.

**Three ways work starts.** A user message is the reactive path. Cron jobs are
the scheduled path: each is a one-shot session with the same tools and
subagents, delivering to a chat or running silently for its side effects. The
heartbeat is the proactive path: a periodic "anything I should know about?"
that stays quiet unless something needs you, which is what makes the assistant
capable of speaking first.

**State on disk.** Sessions and per-chat pins in `STATE_DIR`, structured logs
and a cost audit trail in `LOG_DIR`. Everything else is a config file you
wrote. There is no hidden state to reason about.

**Nothing about a deployment is in the source.** Jobs come from
`CRON_JOBS_FILE`, the heartbeat checklist from `HEARTBEAT_PROMPT_FILE`,
identity from `CLAUDE_CWD/CLAUDE.md`, everything else from the environment.
That is why this repo can be public while the thing it runs is entirely
personal.

## Why so much resilience

A bot you rely on has to survive the night unattended, and the failure that
matters is not a crash. A crash restarts. The dangerous state is a process
that is alive, answering health checks, and deaf, which is exactly what the
Telegram polling library does after certain network errors.

So there are layers, outermost first: the service manager restarts any nonzero
exit; an external watchdog polls `/livez` and kickstarts a wedged process;
in-process watchdogs turn wedges into clean exits (polling staleness, an
undrained-update probe, a zombie-EPIPE detector, an orphan-subprocess reaper);
and per-query guards bound individual work.

The rule they all follow: **degrade, but say so.** Every guard logs why it
fired. A fallback model engaging, a query timing out, a job being skipped
because the queue is busy: each produces a line. A system that silently
recovers is a system you cannot debug when it silently stops recovering.

## The security model, stated plainly

Sessions run with `bypassPermissions`. Claude executes tools without asking,
because a bot that needs terminal confirmation is not a bot. That makes the
allowlist the only thing between a stranger and a shell on your machine, which
is why `ALLOWED_TELEGRAM_USERS` is required with no default and the bridge
refuses to start without it.

Group access needs both the chat and the sender allowed. The control API binds
to loopback and returns 401 until a key is set, because an empty key must
never mean open. The sensitive-keyword guard catches outbound *text* headed for the wrong
chat, but it does not cover file sends, and it is a safety net rather than a
containment boundary.

Run this on hardware you control, for an account you control.

## Choices worth explaining

**Telegram only.** OpenClaw's many-channel support is real work and real
value. Doing one channel properly (media groups, voice notes, streaming
progress, chunking, per-chat pins) was worth more here than doing several
shallowly.

**One process, not a job queue.** The concurrency limit is a semaphore, not a
broker, because the actual constraint is memory: three concurrent Claude
subprocesses is roughly a gigabyte. Infrastructure for coordinating three
things costs more than it returns.

**No prompt classifier.** An earlier version guessed a model tier from
keywords and prompt length. It was unpredictable, and every misroute meant
another regex. Now a model comes from an explicit pin or the default, and an
unrecognized tier warns with the file that carried it. Predictable beats
clever for something spending money on your behalf.

**The heartbeat's checklist is a file, not code.** It could have been a
prompt string. Making it a file you edit means changing what your assistant
watches does not mean changing the bridge.
