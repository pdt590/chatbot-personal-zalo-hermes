import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPlatformEnabled, removePlatformDisabled, setPlatformEnabled } from "../hermesConfig.js";
import { hasZaloAdapter, hostHomeOf, profileHomesUnder } from "../paths.js";

test("getPlatformEnabled: true / false / unset", () => {
  assert.equal(getPlatformEnabled("platforms:\n  zalo:\n    enabled: true\n", "zalo"), true);
  assert.equal(getPlatformEnabled("platforms:\n  zalo:\n    enabled: false # off\n", "zalo"), false);
  assert.equal(getPlatformEnabled("platforms:\n  telegram:\n    enabled: false\n", "zalo"), null);
  assert.equal(getPlatformEnabled("model: x\n", "zalo"), null);
  // A nested key named enabled deeper down is not the platform's own.
  assert.equal(getPlatformEnabled("platforms:\n  zalo:\n    extra:\n      enabled: false\n", "zalo"), null);
});

test("setPlatformEnabled: creates platforms: when missing", () => {
  const r = setPlatformEnabled("model: x\n", "zalo", false);
  assert.equal(r.status, "added");
  assert.equal(r.text, "model: x\nplatforms:\n  zalo:\n    enabled: false\n");
});

test("setPlatformEnabled: adds the platform under an existing platforms:", () => {
  const r = setPlatformEnabled("platforms:\n  webhook:\n    enabled: true\nother: 1\n", "zalo", false);
  assert.equal(r.text, "platforms:\n  zalo:\n    enabled: false\n  webhook:\n    enabled: true\nother: 1\n");
});

test("setPlatformEnabled: adds enabled: to an existing platform block", () => {
  const r = setPlatformEnabled("platforms:\n  zalo:\n    extra:\n      a: 1\n", "zalo", false);
  assert.equal(r.text, "platforms:\n  zalo:\n    enabled: false\n    extra:\n      a: 1\n");
});

test("setPlatformEnabled: flips an existing value, keeps an equal one", () => {
  const on = "platforms:\n  zalo:\n    enabled: true\n";
  assert.equal(setPlatformEnabled(on, "zalo", false).text, "platforms:\n  zalo:\n    enabled: false\n");
  assert.equal(setPlatformEnabled(on, "zalo", true).status, "already");
});

test("removePlatformDisabled: undoes setPlatformEnabled(false)", () => {
  const before = "model: x\nplatforms:\n  webhook:\n    enabled: true\n";
  const set = setPlatformEnabled(before, "zalo", false).text;
  const r = removePlatformDisabled(set, "zalo");
  assert.equal(r.removed, true);
  assert.equal(r.text, before);
  // Only when it is false, and other keys under the platform stay.
  assert.equal(removePlatformDisabled("platforms:\n  zalo:\n    enabled: true\n", "zalo").removed, false);
  const kept = removePlatformDisabled("platforms:\n  zalo:\n    enabled: false\n    extra:\n      a: 1\n", "zalo");
  assert.equal(kept.text, "platforms:\n  zalo:\n    extra:\n      a: 1\n");
});

test("hostHomeOf / profileHomesUnder / hasZaloAdapter", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hzp-host-"));
  try {
    for (const p of ["profiles/lily/plugins/zalo", "profiles/work", "profiles/Bad Name"]) {
      fs.mkdirSync(path.join(root, p), { recursive: true });
    }
    fs.writeFileSync(path.join(root, "profiles/lily/plugins/zalo/adapter.py"), "");
    assert.equal(hostHomeOf(path.join(root, "profiles", "lily")), root);
    assert.equal(hostHomeOf(root), null);
    assert.deepEqual(profileHomesUnder(root).map((h) => h.profile), ["default", "lily", "work"]);
    assert.equal(hasZaloAdapter(path.join(root, "profiles", "lily")), true);
    assert.equal(hasZaloAdapter(path.join(root, "profiles", "work")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
