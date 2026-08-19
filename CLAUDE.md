# Working on this codebase

Notes for anyone, human or agent, changing the bridge itself.

This is **not** the assistant's identity file. The bot's persona comes from the
`CLAUDE.md` in `CLAUDE_CWD`, which is a different directory. See
`CLAUDE.md.example` for a starting point for that one.

## What this is

A Node.js service that runs [Claude Code](https://claude.com/claude-code)
sessions over Telegram, via `@anthropic-ai/claude-agent-sdk`. One process
handles interactive chats, scheduled jobs, a periodic heartbeat, and a local
control API.

## Design intents worth preserving

**CLI parity is the point.** Sessions use the `claude_code` system-prompt
preset with `settingSources: ["user", "project"]`, so they load the workspace
CLAUDE.md, its skills, and its MCP servers. A Telegram session should be able
to do what the `claude` CLI can do in that directory. Preserve this across SDK
upgrades: it is the difference between this and a thin API wrapper.

**Model routing is explicit, never inferred.** There is no prompt classifier.
`models.mjs` owns the whole vocabulary: tier names, resolution to ids,
fallback, and usage checks. A model comes from a pin or from the default
tier, and nothing else:

| Path | Precedence |
|---|---|
| Interactive chat | `ANTHROPIC_MODEL_FORCE` → `/model` pin → default tier |
| Subagent | the agent file's `model:` frontmatter → default tier |
| Cron job | `ANTHROPIC_MODEL_FORCE` → job's `model` field → default tier |

An earlier version classified prompts by keyword and length. It was
unpredictable, and every misroute needed a new regex. If you find yourself
adding one, add a pin instead.

**Unrecognized values warn rather than guessing quietly.** `resolveModelOr`
falls back to the default tier *and* logs which file or job carried the bad
value. A typo that silently runs on the wrong model survives for months.

**Instant rollback.** `ANTHROPIC_MODEL_FORCE=<model-id>` plus a restart sends
all traffic to one model with no code change. It deliberately beats every pin,
and it suppresses `fallbackModel`, because "all traffic on exactly this model"
has to mean it or the rollback isn't one.

**Degrade, but stay observable.** The resilience layers (query semaphore,
wall-clock timeouts, polling watchdogs, orphan reaper, EPIPE safety net) exist
to convert a wedge into a clean restart. Each one logs why it fired. Every
query logs its model and cost. When you add a guard, add its log line too.

**Nothing personal in the repo.** Jobs, heartbeat checklists, chat ids, and
assistant identity live in files the operator supplies and `.gitignore`
excludes. If a change needs a new piece of per-deployment data, it goes in
`config.mjs` reading from the environment, never a literal in a source file.

## Layout

| File | Role |
|---|---|
| `bridge.mjs` | Telegram I/O, session lifecycle, commands, heartbeat, watchdogs |
| `config.mjs` | Every environment-derived setting, read once at startup |
| `models.mjs` | Tiers, resolution, fallback, usage checks |
| `agents.mjs` | Loads subagent definitions from `AGENTS_DIR` |
| `cron-jobs.mjs` | Scheduler engine; jobs come from `CRON_JOBS_FILE` |
| `api-server.mjs` | Local control API + `/livez` |
| `resilience.mjs` | Semaphore, rejection tracker, staleness thresholds, sweeps |
| `error-classify.mjs` | Pure predicates for polling/EPIPE/zombie decisions |
| `session-store.mjs` | Session persistence + rotation |
| `chat-prefs.mjs` | Per-chat model/effort pins |
| `progress.mjs` | Live "what it's doing" status message |
| `media.mjs` | Inbound media groups, outbound file blocks |
| `hooks.mjs` | Cost tracking + audit log |

## Testing

```bash
npm test
```

`tests/setup.mjs` supplies a throwaway allowlist before any import, because
`config.mjs` refuses to start without one. Keep that refusal: a bridge that
boots with an empty allowlist is a bot anyone can talk to.

Tests import real implementations rather than re-implementing logic. Where a
test mirrors bridge internals (message chunking), say so in a comment, so the
next reader knows it can drift.

## Conventions

- Docstrings in reStructuredText.
- Comments explain *why*, especially where behaviour looks odd. Most of the
  strange-looking code in `bridge.mjs` is load-bearing, and the comment says
  which failure it came from.
- Fail loudly. A missing required setting exits at startup; a broken
  `CRON_JOBS_FILE` throws rather than booting with an empty schedule.
