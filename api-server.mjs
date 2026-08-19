/**
 * Control API — a local HTTP surface for driving the bridge from your own
 * dashboard, scripts, or automation. Node's built-in http module, no
 * framework.
 *
 * Binds to 127.0.0.1 only. Every /api/* route requires the BRIDGE_API_KEY in
 * an X-API-Key header; /livez is deliberately open so a process watchdog can
 * poll it without credentials.
 *
 * Endpoints:
 *   GET  /livez                — liveness, unauthenticated
 *   GET  /api/status           — bridge health + uptime
 *   GET  /api/agents           — subagent definitions + session state
 *   GET  /api/crons            — cron job list with status
 *   POST /api/crons/:id/run    — trigger a cron job
 *   GET  /api/costs            — daily cost breakdown
 *   POST /api/dispatch         — run a prompt (async) {prompt, chat_id?, deliver?}
 *   POST /api/webhook          — receive a callback from your own systems
 */

import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config.mjs";
import { defaultModel } from "./models.mjs";

// Deps injected at startup via setApiDeps()
let deps = {
  agents: {},
  listCronJobs: () => [],
  triggerCronJob: async () => null,
  getDailyCosts: () => ({ date: null, total: 0, queries: 0, byType: {} }),
  chatSessions: new Map(),
  activeTasks: new Map(),
  runClaude: async () => "",
  log: console.log,
  heartbeatRunning: () => false,
  isQuietHours: () => false,
};

const startTime = Date.now();

export function setApiDeps(d) {
  deps = { ...deps, ...d };
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

function parseRoute(method, url) {
  const [path, qs] = url.split("?");
  const params = {};

  // POST /api/crons/:id/run
  const cronRunMatch = path.match(/^\/api\/crons\/([^/]+)\/run$/);
  if (cronRunMatch && method === "POST") {
    params.jobId = decodeURIComponent(cronRunMatch[1]);
    return { handler: handleCronRun, params };
  }

  const routes = {
    "GET /api/status": handleStatus,
    "GET /api/agents": handleAgents,
    "GET /api/crons": handleCrons,
    "GET /api/costs": handleCosts,
    "POST /api/dispatch": handleDispatch,
    "POST /api/webhook": handleWebhook,
  };

  const key = `${method} ${path}`;
  if (routes[key]) return { handler: routes[key], params };

  return null;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

// Fail-closed: an unconfigured key NEVER grants access. An empty key must not
// mean "no auth required" — POST /api/dispatch runs arbitrary prompts with
// bypassPermissions on the host, so an open API is a remote shell. Every
// authed route returns 401 until BRIDGE_API_KEY is set. /livez stays open by
// design (a watchdog polls it with no key).
function checkAuth(req) {
  if (!config.apiKey) return false;
  return req.headers["x-api-key"] === config.apiKey;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleStatus() {
  const uptimeMs = Date.now() - startTime;
  return {
    ok: true,
    uptime_ms: uptimeMs,
    uptime_human: formatDuration(uptimeMs),
    agents: Object.keys(deps.agents).length,
    cron_jobs: deps.listCronJobs().length,
    active_sessions: deps.chatSessions.size,
    active_tasks: deps.activeTasks.size,
    heartbeat_running: deps.heartbeatRunning(),
    quiet_hours: deps.isQuietHours(),
    daily_cost: deps.getDailyCosts().total,
  };
}

function handleAgents() {
  const agentList = Object.entries(deps.agents).map(([id, agent]) => ({
    id,
    description: agent.description || "",
    model: agent.model || "sonnet",
    tools: (agent.tools || []).length,
  }));

  // Session info per chat
  const sessions = [];
  for (const [chatId, sess] of deps.chatSessions) {
    const isActive = deps.activeTasks.has(chatId);
    sessions.push({
      chat_id: String(chatId),
      session_id: sess.sessionId || null,
      status: isActive ? "active" : "idle",
      last_activity: sess.lastActivity ? new Date(sess.lastActivity).toISOString() : null,
      last_activity_ago: sess.lastActivity ? formatDuration(Date.now() - sess.lastActivity) : "never",
    });
  }

  // Friendly names for known chats, from the optional CHAT_NAMES map.
  for (const s of sessions) {
    s.name = config.chatNames[s.chat_id] || `chat-${s.chat_id}`;
  }

  sessions.sort((a, b) => (b.last_activity || "").localeCompare(a.last_activity || ""));

  return {
    bridge_ok: true,
    fetched_at: Date.now(),
    agent: {
      name: config.assistantName,
      // The tier unpinned traffic actually runs on. Individual chats and
      // subagents may be pinned elsewhere.
      model: config.modelForce || defaultModel(),
      subagent_model: config.modelForce || defaultModel(),
      status: sessions.some((s) => s.status === "active") ? "active" : sessions.length > 0 ? "idle" : "offline",
      total_sessions: sessions.length,
      active_sessions: sessions.filter((s) => s.status === "active").length,
      last_active_ago: sessions[0]?.last_activity_ago || "never",
    },
    agents: agentList,
    sessions,
  };
}

function handleCrons() {
  const jobs = deps.listCronJobs();
  return jobs.map((j) => ({
    id: j.id,
    name: j.id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    schedule: j.schedule,
    enabled: true,
    running: j.running || false,
    deliverTo: j.deliverTo || null,
    lastRun: j.lastRun || null,
    lastStatus: j.lastStatus || null,
  }));
}

function handleCosts() {
  const costs = deps.getDailyCosts();

  // Read audit logs for daily trend (last 7 days)
  const dailyTrend = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);

    if (dateKey === costs.date) {
      dailyTrend.push({ date: dateKey, cost: Math.round((costs.total || 0) * 100) / 100 });
    } else {
      // Sum costs from that day's audit log
      let dayCost = 0;
      const auditFile = join(config.logDir, `audit-${dateKey}.jsonl`);
      if (existsSync(auditFile)) {
        try {
          const lines = readFileSync(auditFile, "utf-8").trim().split("\n");
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.event === "cost" && entry.cost > 0) dayCost += entry.cost;
            } catch {}
          }
        } catch {}
      }
      dailyTrend.push({ date: dateKey, cost: Math.round(dayCost * 100) / 100 });
    }
  }

  // Build by_model from byType
  const byModel = Object.entries(costs.byType || {}).map(([type, cost]) => ({
    model: type,
    cost: Math.round(cost * 100) / 100,
    pct: costs.total > 0 ? Math.round((cost / costs.total) * 1000) / 10 : 0,
  }));

  // Sum week cost from audit logs
  let weekCost = 0;
  for (const entry of dailyTrend) {
    weekCost += entry.cost;
  }

  return {
    today_cost: Math.round((costs.total || 0) * 100) / 100,
    week_cost: Math.round(weekCost * 100) / 100,
    queries: costs.queries || 0,
    by_model: byModel,
    daily_trend: dailyTrend,
  };
}

async function handleCronRun(params, body) {
  const jobId = params.jobId;
  const result = await deps.triggerCronJob(jobId);
  if (result === null) {
    return { error: `Job not found: ${jobId}`, status: 404 };
  }
  return { success: true, job_id: jobId };
}

async function handleDispatch(params, body) {
  const prompt = body?.prompt;
  const chatId = body?.chat_id || config.defaultChatId;
  if (!prompt) {
    return { error: "Missing required field: prompt", status: 400 };
  }

  // Fire-and-forget: run Claude and optionally deliver to chat
  (async () => {
    try {
      const result = await deps.runClaude(Number(chatId), prompt);
      if (result && body.deliver !== false) {
        const { sendLongMessage } = deps;
        if (sendLongMessage) await sendLongMessage(Number(chatId), result);
      }
    } catch (err) {
      deps.log("error", "dispatch-failed", { error: err.message, prompt: prompt.slice(0, 80) });
    }
  })();

  return { success: true, message: "Dispatched" };
}

async function handleWebhook(params, body) {
  const runId = body?.runId;
  const event = body?.event || "start";
  if (!runId) {
    return { error: "Missing required field: runId", status: 400 };
  }

  deps.log("info", "webhook-received", { runId, event, source: body?.source });

  return { success: true, event };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startApiServer(port = config.apiPort, maxRetries = 10) {
  const server = createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Liveness probe — UNAUTHENTICATED by design. The watchdog
    // (scripts/bridge-watchdog.sh) polls this every 60s with no API key; if it
    // gets anything but 200 it eventually force-restarts the process. Keep this
    // ahead of the auth gate and free of any dependency that could throw, so a
    // healthy event loop always answers 200. Returning 401/404 here made the
    // watchdog SIGTERM a perfectly healthy bridge every ~15 min.
    if (req.method === "GET" && req.url.split("?")[0] === "/livez") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Auth
    if (!checkAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Route
    const route = parseRoute(req.method, req.url);
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      const body = req.method === "POST" ? await readBody(req) : null;
      const result = await route.handler(route.params, body);

      const statusCode = result?.status || 200;
      if (result?.status) delete result.status;

      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      deps.log("error", "api-error", { url: req.url, error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  let attempt = 0;

  function tryListen() {
    // After a failed listen attempt the server handle is in a broken state;
    // close() resets it so the next listen() call gets a fresh socket.
    if (attempt > 0) {
      server.close(() => scheduleRetry());
      return;
    }
    doListen();
  }

  function scheduleRetry() {
    // Cap individual delay at 5s; total budget ≈ up to 50s over 10 attempts
    const delay = Math.min(attempt * 1000, 5000);
    deps.log("warn", "api-port-busy", { port, attempt, maxRetries, retryInMs: delay });
    setTimeout(doListen, delay);
  }

  function doListen() {
    server.listen(port, "127.0.0.1", () => {
      if (!config.apiKey) {
        // log(level, msg, meta) spreads `meta` into the entry — it must be an
        // object, not a string, or the message is spread character by character.
        deps.log("warn", "api-server-locked", {
          hint: "BRIDGE_API_KEY not set — all /api/* routes return 401. /livez stays open for the watchdog. Set BRIDGE_API_KEY to enable the API.",
        });
      }
      deps.log("info", "api-server-start", { port, url: `http://127.0.0.1:${port}`, locked: !config.apiKey });
    });
  }

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attempt < maxRetries) {
      attempt++;
      tryListen();
    } else {
      // Fatal: log + exit so the service manager's restart throttle handles a
      // clean restart, rather than leaving the bridge running headless
      // without its API server.
      deps.log("error", "api-server-fatal", { port, error: err.message, attempt });
      process.exit(1);
    }
  });

  doListen();
  return server;
}
