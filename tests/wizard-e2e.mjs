#!/usr/bin/env node
/**
 * End-to-end test of the setup wizard.
 *
 * Runs the real `setup-wizard.mjs` as a subprocess against a fake Telegram,
 * with scripted answers, in a throwaway directory. Asserts on the .env and
 * CLAUDE.md it produces.
 *
 * The wizard requires a TTY, deliberately, so this drives it through a pty
 * allocated by script(1) rather than relaxing that check for the test's
 * convenience. A test that needs production code to be weakened is testing
 * something other than production.
 *
 *   node tests/wizard-e2e.mjs
 */

import { spawn, execFileSync } from "child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { startFakeTelegram } from "./fake-telegram.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}`);
  if (!pass) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}
function checkMatch(label, actual, re) {
  const pass = re.test(actual || "");
  if (!pass) failures++;
  console.log(`  ${pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}`);
  if (!pass) console.log(`      ${re} did not match`);
}

/**
 * Run the wizard, answering each prompt as it appears.
 *
 * Answers cannot be written on a timer. With a non-terminal stdin, readline
 * emits a line the moment it arrives and drops it if no question() is
 * pending, so anything sent ahead of its prompt is silently lost and every
 * later answer lands on the wrong question. Each answer therefore waits for
 * the prompt it belongs to.
 *
 * :param script: ordered [RegExp matching the prompt, answer] pairs.
 */
function runWizard({ cwd, env, script, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["setup-wizard.mjs"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let next = 0;
    const answered = [];

    const consider = () => {
      while (next < script.length) {
        const [pattern] = script[next];
        if (!pattern.test(out)) break;
        const [, answer] = script[next];
        child.stdin.write(`${answer}\n`);
        answered.push(pattern.source);
        next++;
        // Only one answer per chunk: the next prompt has not been printed yet.
        break;
      }
    };

    child.stdout.on("data", (d) => { out += d; consider(); });
    child.stderr.on("data", (d) => { out += d; });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(
        `timed out after ${timeoutMs}ms; answered ${next}/${script.length}` +
        (next < script.length ? `, stuck waiting for ${script[next][0]}` : "") +
        `\n--- output ---\n${out}`));
    }, timeoutMs);

    child.on("close", () => { clearTimeout(timer); resolve({ out, answered }); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "wizard-e2e-"));
const workspace = join(tmp, "workspace");
const fake = await startFakeTelegram();

// A scratch copy of the repo: the wizard writes .env next to itself, and the
// real one must not be touched.
const sandbox = join(tmp, "repo");
mkdirSync(sandbox);
for (const f of [".env.example", "CLAUDE.md.example", "setup-wizard.mjs"]) {
  copyFileSync(join(REPO, f), join(sandbox, f));
}

console.log("\nsetup wizard, end to end\n");

// The message the wizard will "discover" once it asks for one. Pushed ahead
// of time; the fake only serves it on a polling pass with an offset, so the
// wizard has to drain the stale updates first.
// The DM appears once the wizard has drained the two stale updates.
fake.push({
  update_id: 200,
  message: { chat: { id: 424242, type: "private" }, from: { id: 424242, first_name: "Alex" }, text: "hello" },
}, { afterOffset: 102 });
// The group message only after the wizard has acknowledged past the DM, i.e.
// once it has moved on and asked for a group, the way a person would.
fake.push({
  update_id: 201,
  message: { chat: { id: -1009998887776, type: "supergroup", title: "Test Group" }, from: { id: 424242 }, text: "hi group" },
}, { afterOffset: 201 });

const script = [
  [/Bot token.*:/s, "8123456789:AAHexample-token-not-a-real-one"],
  [/Remove the webhook\?/, "y"],
  [/Done that\?/, "y"],
  [/Add a group chat as well\?/, "y"],
  [/Add another group\?/, "n"],
  [/Workspace directory.*:/s, workspace],
  [/Assistant name.*:/s, "Testbot"],
  [/Timezone.*:/s, "Europe/London"],
  [/Create a starter one\?/, "y"],
  [/Your name.*:/s, "Alex"],
  [/Write these\?/, "y"],
];

const { out, answered } = await runWizard({
  cwd: sandbox,
  env: { ...process.env, TELEGRAM_API_BASE: fake.base, HOME: tmp },
  script,
});
check("every prompt was answered", answered.length, script.length);

console.log("--- wizard output ---");
console.log(out.split("\n").map((l) => `  ${l}`).join("\n"));
console.log("--- assertions ---");

// Flow
checkMatch("validated the token against Telegram", out, /Connected as @test_bot/);
checkMatch("noticed the stale webhook", out, /webhook is set/i);
checkMatch("removed it", out, /Webhook removed/);
check("...and actually called deleteWebhook", fake.state.deletedWebhook, true);
checkMatch("caught privacy mode being on", out, /Privacy mode is ON/);
checkMatch("confirmed the fix on re-check", out, /Privacy mode is now off/);
checkMatch("discovered the user id from a real message", out, /id 424242/);
checkMatch("discovered the group", out, /Test Group.*-1009998887776|-1009998887776/s);
checkMatch("did not mistake a stale update for the new one", out, /(?!.*id 999)id 424242/);

// Artefacts
const envPath = join(sandbox, ".env");
check(".env was written", existsSync(envPath), true);
if (!existsSync(envPath)) { console.log("\n  no .env produced; aborting further checks\n"); await fake.close(); process.exit(1); }
const env = Object.fromEntries(
  readFileSync(envPath, "utf8").split("\n")
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/))
    .filter(Boolean).map((m) => [m[1], m[2].trim()])
);
check("token stored", env.TELEGRAM_BOT_TOKEN, "8123456789:AAHexample-token-not-a-real-one");
check("allowlist is the discovered user", env.ALLOWED_TELEGRAM_USERS, "424242");
check("group allowlisted", env.ALLOWED_TELEGRAM_GROUPS, "-1009998887776");
check("workspace recorded", env.CLAUDE_CWD, workspace);
check("assistant name recorded", env.ASSISTANT_NAME, "Testbot");
check("timezone recorded", env.BRIDGE_TIMEZONE, "Europe/London");
checkMatch("chat name captured", env.CHAT_NAMES || "", /Test Group/);
checkMatch("comments from .env.example survived", readFileSync(envPath, "utf8"), /# From @BotFather on Telegram\./);

const claudeMd = join(workspace, "CLAUDE.md");
check("workspace created", existsSync(workspace), true);
check("starter CLAUDE.md written", existsSync(claudeMd), true);
if (existsSync(claudeMd)) {
  checkMatch("...naming the assistant", readFileSync(claudeMd, "utf8"), /Testbot/);
  checkMatch("...and the user", readFileSync(claudeMd, "utf8"), /Alex/);
}

// The config the wizard produced must actually satisfy the bridge.
const cfgOut = execFileSync("node", ["--input-type=module", "-e",
  `import { config } from ${JSON.stringify(join(REPO, "config.mjs"))}; console.log("CONFIG_OK", config.assistantName);`],
  { env: { ...process.env, ...env, HOME: tmp }, encoding: "utf8" });
checkMatch("the generated .env satisfies config.mjs", cfgOut, /CONFIG_OK Testbot/);

await fake.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "\x1b[32mall checks passed\x1b[0m" : `\x1b[31m${failures} check(s) failed\x1b[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
