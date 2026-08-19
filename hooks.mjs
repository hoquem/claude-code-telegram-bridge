/**
 * SDK hooks for cost tracking, audit logging, and safety.
 */

import { appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config.mjs";

// ---------------------------------------------------------------------------
// Cost tracker — accumulates per-session and daily costs
// Restores from audit log on startup so costs survive restarts
// ---------------------------------------------------------------------------

const dailyCosts = { date: null, total: 0, queries: 0, byType: {}, byModel: {} };

// Restore today's costs from audit log on startup
try {
  const today = new Date().toISOString().slice(0, 10);
  const auditFile = join(config.logDir, `audit-${today}.jsonl`);
  if (existsSync(auditFile)) {
    const lines = readFileSync(auditFile, "utf-8").trim().split("\n");
    let restored = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.event === "cost" && entry.cost > 0) {
          dailyCosts.date = today;
          dailyCosts.total += entry.cost;
          dailyCosts.queries += 1;
          dailyCosts.byType[entry.type] = (dailyCosts.byType[entry.type] || 0) + entry.cost;
          if (entry.model) {
            dailyCosts.byModel[entry.model] = (dailyCosts.byModel[entry.model] || 0) + entry.cost;
          }
          restored++;
        }
      } catch {}
    }
    if (restored > 0) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "costs-restored", date: today, total: dailyCosts.total, queries: restored }));
    }
  }
} catch {}

export function trackCost(type, cost, meta = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyCosts.date !== today) {
    // Log previous day's total if it had data
    if (dailyCosts.date && dailyCosts.total > 0) {
      auditLog("daily-cost-summary", {
        date: dailyCosts.date,
        total: dailyCosts.total,
        queries: dailyCosts.queries,
        byType: dailyCosts.byType,
        byModel: dailyCosts.byModel,
      });
    }
    dailyCosts.date = today;
    dailyCosts.total = 0;
    dailyCosts.queries = 0;
    dailyCosts.byType = {};
    dailyCosts.byModel = {};
  }

  dailyCosts.total += cost;
  dailyCosts.queries += 1;
  dailyCosts.byType[type] = (dailyCosts.byType[type] || 0) + cost;
  if (meta.model) {
    dailyCosts.byModel[meta.model] = (dailyCosts.byModel[meta.model] || 0) + cost;
  }

  auditLog("cost", { type, cost, dailyTotal: dailyCosts.total, ...meta });
}

export function getDailyCosts() {
  return { ...dailyCosts };
}

// ---------------------------------------------------------------------------
// Audit logger — writes to a separate audit log
// ---------------------------------------------------------------------------

export function auditLog(event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...data,
  };

  const today = new Date().toISOString().slice(0, 10);
  const auditFile = join(config.logDir, `audit-${today}.jsonl`);

  try {
    appendFileSync(auditFile, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Don't throw (audit logging must never kill the caller), but surface to
    // stderr so a failing audit disk is visible instead of silently dropping
    // cost/accountability records.
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "audit-write-failed", error: err.message, auditFile }));
  }
}
