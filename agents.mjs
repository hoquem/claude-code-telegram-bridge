/**
 * Subagent roster, loaded from Claude Code agent definition files at startup.
 *
 * Each ``<name>.md`` in the agents directory is a standard Claude Code
 * subagent definition: YAML frontmatter (``name``, ``description``, ``tools``,
 * ``model``) followed by the system prompt as the body. These are the same
 * files the ``claude`` CLI reads, so an agent you already use locally works
 * here with no extra configuration.
 *
 * The frontmatter ``model:`` field is authoritative — routing lives in the
 * agent definition, not in bridge code. Omit it and the agent runs on the
 * default tier.
 *
 * Directory: ``$AGENTS_DIR``, or ``~/.claude/agents`` when unset.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resolveModelOr } from "./models.mjs";

const AGENTS_DIR = process.env.AGENTS_DIR || join(homedir(), ".claude", "agents");

function parseAgentFile(path) {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return { fm, body: m[2].trim() };
}

function loadAgents() {
  const loaded = {};
  let files;
  try {
    files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  } catch (err) {
    // Not fatal — subagents are optional. But say so rather than presenting
    // an empty roster as if it were a deliberate configuration.
    console.error(`agents: cannot read ${AGENTS_DIR} (${err.message}) — no subagents loaded`);
    return loaded;
  }
  for (const f of files) {
    const path = join(AGENTS_DIR, f);
    try {
      const parsed = parseAgentFile(path);
      if (!parsed || !parsed.fm.name || !parsed.body) {
        console.error(`agents: skipping ${f} (missing frontmatter/name/body)`);
        continue;
      }
      const name = parsed.fm.name;
      loaded[name] = {
        description: parsed.fm.description || name,
        prompt: parsed.body,
        tools: (parsed.fm.tools || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        model: resolveModelOr(parsed.fm.model, `agents: ${f}`),
      };
    } catch (err) {
      console.error(`agents: failed to load ${f}: ${err.message}`);
    }
  }
  return loaded;
}

export const agents = loadAgents();
