import { test } from "node:test";
import assert from "node:assert/strict";
import { addPreToolHook, removePreToolHook, setEnvVar } from "../hermesConfig.js";

const CMD = "/home/u/.hermes/profiles/p/agent-hooks/zalo-tool-access.py";
const ENTRY = `    - command: "${CMD}"\n      timeout: 10\n      fail_closed: true`;

test("addPreToolHook: creates the hooks block when missing", () => {
  const r = addPreToolHook("model: x\n", CMD);
  assert.equal(r.status, "added");
  assert.equal(r.text, `model: x\nhooks:\n  pre_tool_call:\n${ENTRY}\n`);
  assert.equal(addPreToolHook(r.text, CMD).status, "already");
});

test("addPreToolHook: appends to an existing pre_tool_call list", () => {
  const cfg = `hooks:\n  pre_tool_call:\n    - command: "/x/other.sh"\n      timeout: 5\n\n  post_tool_call:\n    - command: "/x/post.sh"\nmodel: x\n`;
  const r = addPreToolHook(cfg, CMD);
  assert.equal(r.status, "added");
  assert.match(r.text, /timeout: 5\n    - command: ".*zalo-tool-access.py"\n      timeout: 10\n      fail_closed: true\n\n  post_tool_call:/);
});

test("addPreToolHook: adds pre_tool_call under an existing hooks: and replaces {} / []", () => {
  let r = addPreToolHook("hooks:\n  post_tool_call: []\nmodel: x\n", CMD);
  assert.match(r.text, /^hooks:\n  pre_tool_call:\n    - command:.*\n      timeout: 10\n      fail_closed: true\n  post_tool_call: \[\]\nmodel: x/);
  r = addPreToolHook("hooks: {}\n", CMD);
  assert.equal(r.text, `hooks:\n  pre_tool_call:\n${ENTRY}\n`);
  r = addPreToolHook("hooks:\n  pre_tool_call: []\n", CMD);
  assert.equal(r.text, `hooks:\n  pre_tool_call:\n${ENTRY}\n`);
});

test("addPreToolHook: refreshes a moved hook path instead of duplicating", () => {
  const old = addPreToolHook("", "/old/zalo-tool-access.py").text;
  const r = addPreToolHook(old, CMD);
  assert.equal(r.status, "updated");
  assert.equal((r.text.match(/zalo-tool-access/g) || []).length, 1);
  assert.ok(r.text.includes(CMD));
});

test("addPreToolHook: refuses a non-mapping hooks value", () => {
  assert.throws(() => addPreToolHook("hooks: nope\n", CMD), /by hand/);
});

test("removePreToolHook: removes only our entry", () => {
  const cfg = `hooks:\n  pre_tool_call:\n    - command: "/x/other.sh"\n      timeout: 5\n${ENTRY}\nmodel: x\n`;
  const r = removePreToolHook(cfg);
  assert.equal(r.removed, true);
  assert.equal(r.text, `hooks:\n  pre_tool_call:\n    - command: "/x/other.sh"\n      timeout: 5\nmodel: x\n`);
  assert.equal(removePreToolHook(r.text).removed, false);
});

test("removePreToolHook: an emptied list becomes []", () => {
  const added = addPreToolHook("model: x\n", CMD).text;
  const r = removePreToolHook(added);
  assert.equal(r.text, "model: x\nhooks:\n  pre_tool_call: []\n");
});

test("setEnvVar: replaces or appends", () => {
  assert.deepEqual(setEnvVar("A=1\nZALO_HOOK_OWNERS=1\n", "ZALO_HOOK_OWNERS", "2"),
    { text: "A=1\nZALO_HOOK_OWNERS=2\n", changed: true });
  assert.deepEqual(setEnvVar("A=1", "B", "2"), { text: "A=1\nB=2\n", changed: true });
  assert.equal(setEnvVar("B=2\n", "B", "2").changed, false);
});
