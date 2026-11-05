import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GroupLog } from "../groupLog.js";

const msg = (over) => ({
  threadType: "group", threadId: "g1", messageId: String(Math.random()), senderId: "u1",
  senderName: "An", text: "hi", msgType: "webchat", ts: String(Date.now()), isSelf: false, ...over,
});

test("groupLog: records group messages only, deduplicated", () => {
  const log = new GroupLog({ dir: "/nonexistent", retentionDays: 0 });
  log.record(msg({ messageId: "1" }));
  log.record(msg({ messageId: "1" }));
  log.record(msg({ threadType: "user", messageId: "2" }));
  assert.equal(log.messages("g1").length, 1);
  assert.equal(log.messages("g2").length, 0);
});

test("groupLog: stats count messages and rank senders in the window", () => {
  const log = new GroupLog({ dir: "/nonexistent", retentionDays: 0 });
  const old = Date.now() - 48 * 3_600_000;
  log.record(msg({ ts: String(old), senderId: "u9", senderName: "Old" }));
  log.record(msg({ senderId: "u1", senderName: "An" }));
  log.record(msg({ senderId: "u1", senderName: "An" }));
  log.record(msg({ senderId: "u2", senderName: "Bình" }));
  const s = log.stats(Date.now() - 24 * 3_600_000).g1;
  assert.equal(s.messages, 3);
  assert.equal(s.senders, 2);
  assert.deepEqual(s.topSenders[0], { id: "u1", name: "An", count: 2 });
  assert.equal(log.messages("g1", { sinceMs: Date.now() - 3_600_000 }).length, 3);
});

test("groupLog: persists to an owner-only file and reloads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grouplog-"));
  try {
    const a = new GroupLog({ dir, retentionDays: 3 });
    a.record(msg({ messageId: "x1", text: "xin chào" }));
    await a.close();
    const file = fs.readdirSync(dir)[0];
    assert.match(file, /^group-messages-\d{4}-\d{2}-\d{2}\.jsonl$/);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
    const b = new GroupLog({ dir, retentionDays: 3 });
    assert.equal(b.load(), 1);
    assert.equal(b.messages("g1")[0].x, "xin chào");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("groupLog: prune forgets old messages and deletes old day files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grouplog-"));
  try {
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const now = Date.now();
    const oldFile = path.join(dir, `group-messages-${day(now - 5 * 86_400_000)}.jsonl`);
    const keptFile = path.join(dir, `group-messages-${day(now - 86_400_000)}.jsonl`);
    fs.writeFileSync(oldFile, "");
    fs.writeFileSync(keptFile, "");
    fs.writeFileSync(path.join(dir, "unrelated.txt"), "");

    const log = new GroupLog({ dir, retentionDays: 3 });
    log._push("g1", { id: "a", t: now - 4 * 86_400_000, u: "u", n: "n", x: "cũ", k: "", s: 0 });
    log._push("g1", { id: "b", t: now - 3_600_000, u: "u", n: "n", x: "mới", k: "", s: 0 });
    log._push("g2", { id: "c", t: now - 4 * 86_400_000, u: "u", n: "n", x: "cũ", k: "", s: 0 });

    assert.deepEqual(log.prune(now), { files: 1, messages: 2 });
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(keptFile), true);
    assert.equal(fs.existsSync(path.join(dir, "unrelated.txt")), true);
    assert.deepEqual(log.messages("g1").map((r) => r.x), ["mới"]);
    assert.equal(log.groups.has("g2"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("groupLog: retention 0 keeps nothing on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grouplog-"));
  try {
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, `group-messages-${today}.jsonl`), "");
    const log = new GroupLog({ dir, retentionDays: 0 });
    log.load();
    assert.deepEqual(fs.readdirSync(dir), []);
    log.record(msg({ messageId: "m1" }));
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(log.messages("g1").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
