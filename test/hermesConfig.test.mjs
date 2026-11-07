import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readProvidedToolsets, enablePlatformToolsets } from "../hermesConfig.js";

const CFG = `model: x
platform_toolsets:
  cli:
    - hermes-cli
  zalo-person:
    - file
    - vision
    - todo
    - no_mcp
smart_model_routing:
  enabled: false
`;

test("readProvidedToolsets: reads the list from the shipped plugin.yaml", () => {
  const yaml = fs.readFileSync(new URL("../hermes-plugin/plugin.yaml", import.meta.url), "utf-8");
  assert.deepEqual(readProvidedToolsets(yaml), ["zalo_groups"]);
  assert.deepEqual(readProvidedToolsets("name: x\n"), []);
});

test("enablePlatformToolsets: appends to a block list, once", () => {
  const r = enablePlatformToolsets(CFG, "zalo-person", ["zalo_groups"]);
  assert.equal(r.status, "added");
  assert.match(r.text, /    - no_mcp\n    - zalo_groups\nsmart_model_routing:/);
  assert.match(r.text, /  cli:\n    - hermes-cli\n  zalo-person:/); // other platforms untouched
  const again = enablePlatformToolsets(r.text, "zalo-person", ["zalo_groups"]);
  assert.equal(again.status, "already");
  assert.equal(again.text, r.text);
});

test("enablePlatformToolsets: inline list", () => {
  const r = enablePlatformToolsets("platform_toolsets:\n  zalo-person: [file, vision]\n", "zalo-person", ["zalo_groups"]);
  assert.equal(r.text, "platform_toolsets:\n  zalo-person: [file, vision, zalo_groups]\n");
});

test("enablePlatformToolsets: no saved list leaves the config alone (defaults already include plugin toolsets)", () => {
  assert.equal(enablePlatformToolsets("model: x\n", "zalo-person", ["zalo_groups"]).status, "default");
  const noZalo = "platform_toolsets:\n  cli:\n    - hermes-cli\nother: 1\n";
  const r = enablePlatformToolsets(noZalo, "zalo-person", ["zalo_groups"]);
  assert.equal(r.status, "default");
  assert.equal(r.text, noZalo);
});

test("enablePlatformToolsets: a non-list value is refused", () => {
  assert.throws(() => enablePlatformToolsets("platform_toolsets:\n  zalo-person: hermes-zalo\n", "zalo-person", ["zalo_groups"]));
});
