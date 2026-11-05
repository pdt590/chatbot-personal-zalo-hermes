import { test } from "node:test";
import assert from "node:assert/strict";
import { enablePluginInConfig, disablePluginInConfig } from "../hermesConfig.js";

test("enablePluginInConfig: creates the plugins block when missing", () => {
  const r = enablePluginInConfig("model: x\n");
  assert.equal(r.status, "created");
  assert.match(r.text, /plugins:\n {2}enabled:\n {4}- zalo-platform\n$/);
});

test("enablePluginInConfig: adds enabled: under an existing plugins:", () => {
  const r = enablePluginInConfig("plugins:\n  disabled: []\n");
  assert.equal(r.status, "added");
  assert.equal(r.text, "plugins:\n  enabled:\n    - zalo-platform\n  disabled: []\n");
});

test("enablePluginInConfig: appends to a block list, idempotent", () => {
  const cfg = "plugins:\n  enabled:\n    - other\n\nmodel: x\n";
  const r = enablePluginInConfig(cfg);
  assert.equal(r.status, "added");
  assert.equal(r.text, "plugins:\n  enabled:\n    - other\n    - zalo-platform\n\nmodel: x\n");
  assert.equal(enablePluginInConfig(r.text).status, "already");
});

test("enablePluginInConfig: appends to an inline list, idempotent", () => {
  const r = enablePluginInConfig("plugins:\n  enabled: [other]\n");
  assert.equal(r.text, "plugins:\n  enabled: [other, zalo-platform]\n");
  assert.equal(enablePluginInConfig(r.text).status, "already");
  assert.equal(enablePluginInConfig("plugins:\n  enabled: []\n").text, "plugins:\n  enabled: [zalo-platform]\n");
});

test("disablePluginInConfig: removes from block and inline lists", () => {
  const block = disablePluginInConfig("plugins:\n  enabled:\n    - other\n    - zalo-platform\nmodel: x\n");
  assert.deepEqual(block, { text: "plugins:\n  enabled:\n    - other\nmodel: x\n", removed: true });
  const inline = disablePluginInConfig("plugins:\n  enabled: [a, 'zalo-platform', b]\n");
  assert.deepEqual(inline, { text: "plugins:\n  enabled: [a, b]\n", removed: true });
});

test("disablePluginInConfig: no-op when absent", () => {
  for (const cfg of ["", "model: x\n", "plugins:\n  enabled:\n    - other\n", "plugins:\n  enabled: [a]\n"]) {
    assert.deepEqual(disablePluginInConfig(cfg), { text: cfg, removed: false });
  }
});
