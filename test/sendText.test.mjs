import { test } from "node:test";
import assert from "node:assert/strict";
import { ZaloClient } from "../zaloClient.js";
import { formatZaloMarkdown } from "../markdownToZalo.js";

// A ZaloClient with a fake zca-js api that records each sendMessage call.
function fakeClient() {
  const client = Object.create(ZaloClient.prototype);
  const sent = [];
  client.api = {
    async sendMessage(content, threadId, type) {
      sent.push({ content, threadId, type });
      return { message: { msgId: `m${sent.length}` }, attachment: [] };
    },
  };
  return { client, sent };
}

test("sendText: short markdown goes out as one styled message", async () => {
  const { client, sent } = fakeClient();
  const res = await client.sendText("42", "user", "**Chào** bạn");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].content, { msg: "Chào bạn", styles: [{ start: 0, len: 4, st: "b" }] });
  assert.equal(sent[0].threadId, "42");
  assert.deepEqual(res, { message: { msgId: "m1" }, attachment: [] });
});

test("sendText: plain text has no styles field", async () => {
  const { client, sent } = fakeClient();
  await client.sendText(1, "user", "xin chào");
  assert.deepEqual(sent[0].content, { msg: "xin chào" });
});

test("sendText: a reply over Zalo's limits is split, quote on the first part only", async () => {
  const { client, sent } = fakeClient();
  const md = Array.from({ length: 8 }, (_, n) => `**Mục ${n}** ` + "nội dung tiếng Việt có dấu. ".repeat(20)).join("\n\n");
  const quote = { msgId: "q1" };
  const res = await client.sendText("42", "group", md, undefined, quote);

  assert.ok(sent.length > 1, `expected a split, got ${sent.length} message(s)`);
  for (const [n, { content }] of sent.entries()) {
    assert.ok(content.msg.length <= 2000);
    assert.ok(!content.styles || content.styles.length <= 40);
    assert.equal("quote" in content, n === 0);
  }
  assert.equal(sent.map((s) => s.content.msg).join(""), formatZaloMarkdown(md.trim()).msg);
  // The adapter reads msgId from the result: it is the last part's.
  assert.equal(res.message.msgId, `m${sent.length}`);
  assert.equal(res.parts.length, sent.length);
});

test("sendText: explicit styles are trusted and never split or reformatted", async () => {
  const { client, sent } = fakeClient();
  const styles = [{ start: 0, len: 2, st: "i" }];
  await client.sendText("42", "user", "**x**", undefined, undefined, styles);
  assert.deepEqual(sent, [{ content: { msg: "**x**", styles }, threadId: "42", type: sent[0].type }]);
});

test("sendText: mentions keep the text as written so their positions stay valid", async () => {
  const { client, sent } = fakeClient();
  const mentions = [{ pos: 9, uid: "7", len: 4 }];
  await client.sendText("g", "group", "**Chào** @Lan", mentions);
  assert.deepEqual(sent[0].content, { msg: "**Chào** @Lan", mentions });
});

test("sendText: with mentions, markup that would move text is sent unconverted", async () => {
  const { client, sent } = fakeClient();
  const mentions = [{ pos: 0, uid: "7", len: 4 }];
  await client.sendText("g", "group", "@Lan [red]gấp[/red]", mentions);
  // Color tags are removed, which would move text: fall back to plain text.
  assert.deepEqual(sent[0].content, { msg: "@Lan [red]gấp[/red]", mentions });
});
