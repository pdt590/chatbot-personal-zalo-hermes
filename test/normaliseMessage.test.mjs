import { test } from "node:test";
import assert from "node:assert/strict";
import { ZaloClient, ThreadType } from "../zaloClient.js";

const client = Object.create(ZaloClient.prototype);
client.selfListen = false;

const groupMessage = (data) => ({ type: ThreadType.Group, threadId: "6695", isSelf: false, data });

test("normalise: a group reply carries the quoted message", () => {
  const ev = client._normaliseMessage(
    groupMessage({
      msgId: "100",
      uidFrom: "7",
      dName: "Hubplus",
      content: "@Lily nhân 10 thì sao?",
      mentions: [{ uid: "42", pos: 0, len: 5, type: 0 }],
      quote: { ownerId: "42", globalMsgId: 99, fromD: "Lily", msg: "2 + 3 = 5", cliMsgId: 1, ts: 1 },
    }),
  );
  assert.equal(ev.threadType, "group");
  assert.deepEqual(ev.mentions, ["42"]);
  assert.equal(ev.quotedOwnerId, "42");
  assert.deepEqual(ev.quoted, { msgId: "99", senderId: "42", senderName: "Lily", text: "2 + 3 = 5" });
});

test("normalise: a message without a quote has quoted=null", () => {
  const ev = client._normaliseMessage(groupMessage({ msgId: "101", uidFrom: "7", content: "hello" }));
  assert.equal(ev.quoted, null);
  assert.equal(ev.quotedOwnerId, "");
});
