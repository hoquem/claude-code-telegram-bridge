// Capture a real wizard run for documentation: same code path as the e2e
// test, with presentable answers, and each answer echoed into the transcript
// where the terminal would show it.
import { spawn } from "child_process";
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startFakeTelegram } from "../tests/fake-telegram.mjs";

const tmp = mkdtempSync(join(tmpdir(), "cap-"));
const sandbox = join(tmp, "bridge"); mkdirSync(sandbox);
for (const f of [".env.example", "CLAUDE.md.example", "setup-wizard.mjs"]) copyFileSync(f, join(sandbox, f));
const fake = await startFakeTelegram();
fake.push({ update_id: 200, message: { chat: { id: 8148000111, type: "private" }, from: { id: 8148000111, first_name: "Alex" }, text: "hi" } }, { afterOffset: 102 });
fake.push({ update_id: 201, message: { chat: { id: -1001234567890, type: "supergroup", title: "Home" }, from: { id: 8148000111 }, text: "hi" } }, { afterOffset: 201 });

const script = [
  [/Bot token.*:/s, "8123456789:AAHexample-token-not-a-real-one"],
  [/Remove the webhook\?/, "y"],
  [/Done that\?/, "y"],
  [/Add a group chat as well\?/, "y"],
  [/Add another group\?/, "n"],
  [/Workspace directory.*:/s, join(tmp, "my-assistant")],
  [/Assistant name.*:/s, "Ada"],
  [/Timezone.*:/s, ""],
  [/Create a starter one\?/, "y"],
  [/Your name.*:/s, "Alex"],
  [/Write these\?/, "y"],
];

const child = spawn("node", ["setup-wizard.mjs"], { cwd: sandbox, env: { ...process.env, TELEGRAM_API_BASE: fake.base, HOME: tmp, TZ: "Europe/London" }, stdio: ["pipe","pipe","pipe"] });
let out = "", next = 0;
child.stdout.on("data", (d) => {
  out += d;
  if (next < script.length && script[next][0].test(out)) {
    const answer = script[next][1];
    out += answer + "\n";           // echo, as a terminal would
    child.stdin.write(answer + "\n");
    next++;
  }
});
child.stderr.on("data", (d) => { out += d; });
await new Promise((r) => { child.on("close", r); setTimeout(() => { child.kill("SIGKILL"); r(); }, 60000); });
writeFileSync("/tmp/wizard-real.txt", out.replaceAll(tmp, "/Users/you").replaceAll("/private/Users/you", "/Users/you"));
await fake.close();
console.log(`captured ${out.split("\n").length} lines, answered ${next}/${script.length}`);
