import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseOutboundFiles, createMediaGroupDebouncer } from "../media.mjs";

const TEST_DIR = join(tmpdir(), "media-test-" + Date.now());

describe("parseOutboundFiles", () => {
  it("returns empty for text without file blocks", () => {
    const result = parseOutboundFiles("Hello, here is your report.");
    assert.equal(result.cleanText, "Hello, here is your report.");
    assert.equal(result.files.length, 0);
  });

  it("returns empty for null/undefined", () => {
    assert.equal(parseOutboundFiles(null).files.length, 0);
    assert.equal(parseOutboundFiles(undefined).files.length, 0);
  });

  it("extracts file paths from outbound_files block", () => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    const testFile = join(TEST_DIR, "report.pdf");
    writeFileSync(testFile, "test");

    const text = `Here is your report.

<outbound_files>
${testFile} | Monthly report
</outbound_files>

Let me know if you need anything else.`;

    const result = parseOutboundFiles(text);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, testFile);
    assert.equal(result.files[0].caption, "Monthly report");
    assert.equal(result.cleanText.includes("<outbound_files>"), false);
    assert.equal(result.cleanText.includes("Here is your report."), true);
    assert.equal(result.cleanText.includes("Let me know"), true);

    unlinkSync(testFile);
  });

  it("skips non-existent files", () => {
    const text = `<outbound_files>
/nonexistent/file.pdf | Fake file
</outbound_files>`;

    const result = parseOutboundFiles(text);
    assert.equal(result.files.length, 0);
  });

  it("handles files without captions", () => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    const testFile = join(TEST_DIR, "data.csv");
    writeFileSync(testFile, "a,b,c");

    const text = `<outbound_files>
${testFile}
</outbound_files>`;

    const result = parseOutboundFiles(text);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].caption, null);

    unlinkSync(testFile);
  });

  it("handles multiple file blocks", () => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    const f1 = join(TEST_DIR, "a.txt");
    const f2 = join(TEST_DIR, "b.txt");
    writeFileSync(f1, "a");
    writeFileSync(f2, "b");

    const text = `First batch:
<outbound_files>
${f1} | File A
</outbound_files>

Second batch:
<outbound_files>
${f2} | File B
</outbound_files>`;

    const result = parseOutboundFiles(text);
    assert.equal(result.files.length, 2);

    unlinkSync(f1);
    unlinkSync(f2);
  });
});

describe("createMediaGroupDebouncer", () => {
  it("fires callback after delay with collected messages", async () => {
    let fired = false;
    let receivedMessages = [];

    const debouncer = createMediaGroupDebouncer(100, (chatId, messages) => {
      fired = true;
      receivedMessages = messages;
    });

    const msg1 = { media_group_id: "g1", chat: { id: 123 }, caption: "photo 1" };
    const msg2 = { media_group_id: "g1", chat: { id: 123 }, caption: "photo 2" };

    debouncer.add(msg1);
    debouncer.add(msg2);

    assert.equal(debouncer.pendingCount, 1);

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(fired, true);
    assert.equal(receivedMessages.length, 2);
    assert.equal(debouncer.pendingCount, 0);
  });

  it("handles separate media groups independently", async () => {
    const groups = [];

    const debouncer = createMediaGroupDebouncer(100, (chatId, messages) => {
      groups.push({ chatId, count: messages.length });
    });

    debouncer.add({ media_group_id: "a", chat: { id: 1 } });
    debouncer.add({ media_group_id: "b", chat: { id: 2 } });
    debouncer.add({ media_group_id: "a", chat: { id: 1 } });

    assert.equal(debouncer.pendingCount, 2);

    await new Promise((r) => setTimeout(r, 200));

    assert.equal(groups.length, 2);
    const groupA = groups.find((g) => g.chatId === 1);
    const groupB = groups.find((g) => g.chatId === 2);
    assert.equal(groupA.count, 2);
    assert.equal(groupB.count, 1);
  });

  it("returns false for messages without media_group_id", () => {
    const debouncer = createMediaGroupDebouncer(100, () => {});
    assert.equal(debouncer.add({ chat: { id: 1 } }), false);
  });

  it("clears pending groups on clear()", () => {
    const debouncer = createMediaGroupDebouncer(5000, () => {});
    debouncer.add({ media_group_id: "g1", chat: { id: 1 } });
    assert.equal(debouncer.pendingCount, 1);
    debouncer.clear();
    assert.equal(debouncer.pendingCount, 0);
  });
});
