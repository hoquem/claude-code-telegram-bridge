/**
 * HTTP-level tests for api-server.mjs — the security boundary.
 *
 * These spin up the real server on an ephemeral port with stubbed deps and
 * exercise auth + routing over real HTTP, because the auth behaviour is the
 * highest-risk surface (POST /api/dispatch runs arbitrary Claude prompts).
 *
 * Fail-closed contract under test: when BRIDGE_API_KEY is not set, every /api/*
 * route MUST return 401; /livez MUST stay open (the launchd watchdog polls it
 * with no key). A missing key must never open the API.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { config } from "../config.mjs";
import { setApiDeps, startApiServer } from "../api-server.mjs";

// ---------------------------------------------------------------------------
// Stub deps — capture calls without invoking the SDK
// ---------------------------------------------------------------------------

const calls = {
  triggerCronJob: [],
  runClaude: [],
  sendLongMessage: [],
};

let server;
let port;

function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() })
        );
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  setApiDeps({
    agents: {},
    listCronJobs: () => [{ id: "test-job", schedule: "0 0 * * *", running: false }],
    triggerCronJob: async (jobId) => {
      calls.triggerCronJob.push(jobId);
      return jobId === "test-job" ? true : null;
    },
    getDailyCosts: () => ({ date: "2026-07-01", total: 0.42, queries: 3, byType: { cron: 0.42 } }),
    chatSessions: new Map(),
    activeTasks: new Map(),
    runClaude: async (chatId, prompt) => {
      calls.runClaude.push({ chatId, prompt });
      return "stubbed-response";
    },
    sendLongMessage: async (chatId, text) => {
      calls.sendLongMessage.push({ chatId, text });
    },
    log: () => {},
    heartbeatRunning: () => false,
    isQuietHours: () => false,
  });

  server = startApiServer(0, 0); // ephemeral port; 0 retries (port 0 won't clash)
  await once(server, "listening");
  port = server.address().port;
});

after(async () => {
  // closeAllConnections exists on Node 18.2+; fall back to close() so the
  // test process can actually exit.
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  // Restore config so we don't leak a test key into anything else in this process.
  config.apiKey = "";
});

describe("API server — /livez", () => {
  it("returns 200 with no auth (watchdog probes it keyless)", async () => {
    // No key configured for this test; /livez must still answer.
    config.apiKey = "";
    const res = await request("GET", "/livez");
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, true);
  });
});

describe("API server — fail-closed auth (no BRIDGE_API_KEY)", () => {
  it("denies GET /api/status with 401 when no key configured", async () => {
    config.apiKey = "";
    const res = await request("GET", "/api/status");
    assert.equal(res.statusCode, 401);
  });

  it("denies POST /api/dispatch with 401 when no key configured", async () => {
    config.apiKey = "";
    const res = await request("POST", "/api/dispatch", { body: { prompt: "hi" } });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.runClaude.length, 0, "must NOT run Claude without a key");
  });

  it("denies POST /api/crons/:id/run with 401 when no key configured", async () => {
    config.apiKey = "";
    const res = await request("POST", "/api/crons/test-job/run");
    assert.equal(res.statusCode, 401);
    assert.equal(calls.triggerCronJob.length, 0, "must NOT trigger a cron without a key");
  });

  it("denies even when a key HEADER is sent but no server key is configured", async () => {
    // A caller guessing/sending a header must not bypass the empty-key lock.
    config.apiKey = "";
    const res = await request("GET", "/api/status", { headers: { "x-api-key": "anything" } });
    assert.equal(res.statusCode, 401);
  });
});

describe("API server — auth with key configured", () => {
  it("rejects requests with no key header", async () => {
    config.apiKey = "secret-key";
    const res = await request("GET", "/api/status");
    assert.equal(res.statusCode, 401);
  });

  it("rejects requests with the wrong key", async () => {
    config.apiKey = "secret-key";
    const res = await request("GET", "/api/status", { headers: { "x-api-key": "wrong" } });
    assert.equal(res.statusCode, 401);
  });

  it("accepts GET /api/status with the correct key", async () => {
    config.apiKey = "secret-key";
    const res = await request("GET", "/api/status", { headers: { "x-api-key": "secret-key" } });
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, true);
    assert.ok(json.uptime_ms >= 0);
  });

  it("rejects POST /api/dispatch with wrong key (must not run Claude)", async () => {
    config.apiKey = "secret-key";
    const before = calls.runClaude.length;
    const res = await request("POST", "/api/dispatch",
      { headers: { "x-api-key": "wrong" }, body: { prompt: "pwn" } });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.runClaude.length, before, "wrong key must not invoke runClaude");
  });

  it("returns 400 on POST /api/dispatch with correct key but missing prompt", async () => {
    config.apiKey = "secret-key";
    const res = await request("POST", "/api/dispatch",
      { headers: { "x-api-key": "secret-key" }, body: {} });
    assert.equal(res.statusCode, 400);
    const json = JSON.parse(res.body);
    assert.match(json.error, /prompt/i);
  });

  it("accepts POST /api/dispatch with correct key + prompt (fire-and-forget 200)", async () => {
    config.apiKey = "secret-key";
    const res = await request("POST", "/api/dispatch",
      { headers: { "x-api-key": "secret-key" }, body: { prompt: "hello", chat_id: 123 } });
    assert.equal(res.statusCode, 200);
    // dispatch is fire-and-forget; give the microtask a tick to land
    await new Promise((r) => setTimeout(r, 20));
    const found = calls.runClaude.some((c) => c.chatId === 123 && c.prompt === "hello");
    assert.ok(found, "runClaude should be invoked with the supplied chat_id + prompt");
  });

  it("accepts POST /api/crons/:id/run with correct key and triggers the job", async () => {
    config.apiKey = "secret-key";
    const before = calls.triggerCronJob.length;
    const res = await request("POST", "/api/crons/test-job/run",
      { headers: { "x-api-key": "secret-key" } });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.triggerCronJob.length, before + 1);
  });

  it("returns 404 on unknown route", async () => {
    config.apiKey = "secret-key";
    const res = await request("GET", "/api/nope", { headers: { "x-api-key": "secret-key" } });
    assert.equal(res.statusCode, 404);
  });

  it("responds 204 to OPTIONS (CORS preflight) without auth", async () => {
    config.apiKey = "secret-key";
    const res = await request("OPTIONS", "/api/status");
    assert.equal(res.statusCode, 204);
  });
});