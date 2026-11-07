import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPlatformEnabled, removePlatformDisabled, renameSectionKey, setPlatformEnabled } from "../hermesConfig.js";
import { hasZaloAdapter, hostHomeOf, profileHomesUnder } from "../paths.js";

test("getPlatformEnabled: true / false / unset", () => {
  assert.equal(getPlatformEnabled("platforms:\n  zalo-person:\n    enabled: true\n", "zalo-person"), true);
  assert.equal(getPlatformEnabled("platforms:\n  zalo-person:\n    enabled: false # off\n", "zalo-person"), false);
  assert.equal(getPlatformEnabled("platforms:\n  telegram:\n    enabled: false\n", "zalo-person"), null);
  assert.equal(getPlatformEnabled("model: x\n", "zalo-person"), null);
  // A nested key named enabled deeper down is not the platform's own.
  assert.equal(getPlatformEnabled("platforms:\n  zalo-person:\n    extra:\n      enabled: false\n", "zalo-person"), null);
});

test("setPlatformEnabled: creates platforms: when missing", () => {
  const r = setPlatformEnabled("model: x\n", "zalo-person", false);
  assert.equal(r.status, "added");
  assert.equal(r.text, "model: x\nplatforms:\n  zalo-person:\n    enabled: false\n");
});

test("setPlatformEnabled: adds the platform under an existing platforms:", () => {
  const r = setPlatformEnabled("platforms:\n  webhook:\n    enabled: true\nother: 1\n", "zalo-person", false);
  assert.equal(r.text, "platforms:\n  zalo-person:\n    enabled: false\n  webhook:\n    enabled: true\nother: 1\n");
});

test("setPlatformEnabled: adds enabled: to an existing platform block", () => {
  const r = setPlatformEnabled("platforms:\n  zalo-person:\n    extra:\n      a: 1\n", "zalo-person", false);
  assert.equal(r.text, "platforms:\n  zalo-person:\n    enabled: false\n    extra:\n      a: 1\n");
});

test("setPlatformEnabled: flips an existing value, keeps an equal one", () => {
  const on = "platforms:\n  zalo-person:\n    enabled: true\n";
  assert.equal(setPlatformEnabled(on, "zalo-person", false).text, "platforms:\n  zalo-person:\n    enabled: false\n");
  assert.equal(setPlatformEnabled(on, "zalo-person", true).status, "already");
});

test("removePlatformDisabled: undoes setPlatformEnabled(false)", () => {
  const before = "model: x\nplatforms:\n  webhook:\n    enabled: true\n";
  const set = setPlatformEnabled(before, "zalo-person", false).text;
  const r = removePlatformDisabled(set, "zalo-person");
  assert.equal(r.removed, true);
  assert.equal(r.text, before);
  // Only when it is false, and other keys under the platform stay.
  assert.equal(removePlatformDisabled("platforms:\n  zalo-person:\n    enabled: true\n", "zalo-person").removed, false);
  const kept = removePlatformDisabled("platforms:\n  zalo-person:\n    enabled: false\n    extra:\n      a: 1\n", "zalo-person");
  assert.equal(kept.text, "platforms:\n  zalo-person:\n    extra:\n      a: 1\n");
});

test("hostHomeOf / profileHomesUnder / hasZaloAdapter", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hzp-host-"));
  try {
    for (const p of ["profiles/lily/plugins/zalo-person", "profiles/old/plugins/zalo", "profiles/work", "profiles/Bad Name"]) {
      fs.mkdirSync(path.join(root, p), { recursive: true });
    }
    fs.writeFileSync(path.join(root, "profiles/lily/plugins/zalo-person/adapter.py"), "");
    fs.writeFileSync(path.join(root, "profiles/old/plugins/zalo/adapter.py"), "");
    assert.equal(hostHomeOf(path.join(root, "profiles", "lily")), root);
    assert.equal(hostHomeOf(root), null);
    assert.deepEqual(profileHomesUnder(root).map((h) => h.profile), ["default", "lily", "old", "work"]);
    assert.equal(hasZaloAdapter(path.join(root, "profiles", "lily")), true);
    assert.equal(hasZaloAdapter(path.join(root, "profiles", "old")), true); // legacy plugins/zalo
    assert.equal(hasZaloAdapter(path.join(root, "profiles", "work")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renameSectionKey: moves the legacy platform key, keeps its body", () => {
  const cfg = "platforms:\n  telegram:\n    enabled: false\n  zalo:\n    enabled: true\nplatform_toolsets:\n  zalo: [file, zalo_groups]\n";
  let r = renameSectionKey(cfg, "platforms", "zalo", "zalo-person");
  assert.equal(r.status, "renamed");
  r = renameSectionKey(r.text, "platform_toolsets", "zalo", "zalo-person");
  assert.equal(r.text,
    "platforms:\n  telegram:\n    enabled: false\n  zalo-person:\n    enabled: true\nplatform_toolsets:\n  zalo-person: [file, zalo_groups]\n");
  assert.equal(renameSectionKey(r.text, "platforms", "zalo", "zalo-person").status, "absent");
  assert.equal(renameSectionKey("model: x\n", "platforms", "zalo", "zalo-person").status, "absent");
  // a nested "zalo:" deeper in the block is not the platform key
  assert.equal(renameSectionKey("platforms:\n  a:\n    zalo: 1\n", "platforms", "zalo", "zalo-person").status, "absent");
  const both = "platforms:\n  zalo:\n    enabled: true\n  zalo-person:\n    enabled: false\n";
  assert.deepEqual(renameSectionKey(both, "platforms", "zalo", "zalo-person"), { text: both, status: "conflict" });
});
