import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnvFile, loadBridgeEnv, restrictToOwner, writePrivateFile } from "../paths.js";

test("parseEnvFile handles comments, export, quotes and blanks", () => {
  const vars = parseEnvFile(
    ["# comment", "", "A=1", "export B = two words ", "C=\"quoted # not a comment\"", "D='x'", "bad line", "E="].join("\n"),
  );
  assert.deepEqual(vars, { A: "1", B: "two words", C: "quoted # not a comment", D: "x", E: "" });
});

test("loadBridgeEnv fills missing vars but never overrides real env", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-env-"));
  const file = path.join(dir, "bridge.env");
  fs.writeFileSync(file, "ZALO_TEST_FROM_FILE=file\nZALO_TEST_ALREADY_SET=file\n");
  const saved = { ...process.env };
  try {
    process.env.ZALO_BRIDGE_ENV = file;
    process.env.ZALO_TEST_ALREADY_SET = "env";
    delete process.env.ZALO_TEST_FROM_FILE;
    const r = loadBridgeEnv();
    assert.equal(r.file, file);
    assert.deepEqual(r.applied, ["ZALO_TEST_FROM_FILE"]);
    assert.equal(process.env.ZALO_TEST_FROM_FILE, "file");
    assert.equal(process.env.ZALO_TEST_ALREADY_SET, "env");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadBridgeEnv tolerates a missing file", () => {
  const saved = process.env.ZALO_BRIDGE_ENV;
  process.env.ZALO_BRIDGE_ENV = path.join(os.tmpdir(), "does-not-exist-zalo.env");
  try {
    assert.deepEqual(loadBridgeEnv().applied, []);
  } finally {
    if (saved === undefined) delete process.env.ZALO_BRIDGE_ENV;
    else process.env.ZALO_BRIDGE_ENV = saved;
  }
});

test("writePrivateFile creates owner-only files and tightens existing ones", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-priv-"));
  try {
    const fresh = path.join(dir, "sub", "credentials.json");
    writePrivateFile(fresh, "{}");
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(fresh, "utf-8"), "{}");

    const old = path.join(dir, "old.json"); // as saved by <=1.0.13
    fs.writeFileSync(old, "x");
    fs.chmodSync(old, 0o664);
    writePrivateFile(old, "y");
    assert.equal(fs.statSync(old).mode & 0o777, 0o600);

    const loaded = path.join(dir, "loaded.json");
    fs.writeFileSync(loaded, "z");
    fs.chmodSync(loaded, 0o644);
    restrictToOwner(loaded);
    assert.equal(fs.statSync(loaded).mode & 0o777, 0o600);
    restrictToOwner(path.join(dir, "missing.json")); // must not throw
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHermesHome maps a profile name like Hermes does", async () => {
  const { resolveHermesHome, profileHome, hermesRoot } = await import("../paths.js");
  const root = hermesRoot({});
  assert.equal(profileHome("default", {}), root);
  assert.equal(profileHome("Zalo8806", {}), path.join(root, "profiles", "zalo8806"));

  const named = resolveHermesHome(["--profile", "zalo8806"], {});
  assert.deepEqual(named, { dir: path.join(root, "profiles", "zalo8806"), profile: "zalo8806", source: "profile" });
  assert.equal(resolveHermesHome(["-p=work"], {}).dir, path.join(root, "profiles", "work"));
  assert.equal(resolveHermesHome(["--profile", "default"], {}).dir, root);

  const fromEnv = resolveHermesHome([], { HERMES_PROFILE: "work" });
  assert.equal(fromEnv.source, "env-profile");
  assert.equal(fromEnv.dir, path.join(root, "profiles", "work"));
  assert.equal(resolveHermesHome([], {}).source, "default");

  assert.throws(() => resolveHermesHome(["--profile", "../etc"], {}), /not a valid Hermes profile name/);
  assert.throws(() => resolveHermesHome(["--profile"], {}), /requires a value/);
  assert.throws(() => resolveHermesHome(["--profile", "a", "--hermes-home", "/x"], {}), /not both/);
});

test("profiles live under a custom HERMES_HOME root, and --hermes-home names its profile", async () => {
  const { resolveHermesHome, hermesRoot } = await import("../paths.js");
  const custom = path.resolve("/opt/data");
  assert.equal(hermesRoot({ HERMES_HOME: custom }), custom);
  assert.equal(hermesRoot({ HERMES_HOME: path.join(custom, "profiles", "x") }), custom);
  assert.equal(
    resolveHermesHome(["--profile", "work"], { HERMES_HOME: custom }).dir,
    path.join(custom, "profiles", "work"),
  );
  const explicit = resolveHermesHome(["--hermes-home", path.join(custom, "profiles", "lily")], {});
  assert.equal(explicit.source, "flag");
  assert.equal(explicit.profile, "lily");
});

test("resolveHermesHomes accepts a comma-separated profile list", async () => {
  const { resolveHermesHomes, hermesRoot } = await import("../paths.js");
  const root = hermesRoot({});
  const many = resolveHermesHomes(["--profile", "default,Work, work,lily"], {});
  assert.deepEqual(many.map((h) => h.dir), [root, path.join(root, "profiles", "work"), path.join(root, "profiles", "lily")]);
  assert.ok(many.every((h) => h.source === "profile"));
  assert.deepEqual(resolveHermesHomes([], { HERMES_PROFILE: "a,b" }).map((h) => h.profile), ["a", "b"]);
  // A single value behaves exactly like resolveHermesHome.
  assert.deepEqual(resolveHermesHomes(["-p", "work"], {}), [{ dir: path.join(root, "profiles", "work"), profile: "work", source: "profile" }]);
  assert.deepEqual(resolveHermesHomes([], {}).map((h) => h.source), ["default"]);
  assert.throws(() => resolveHermesHomes(["--profile", "a,../x"], {}), /not a valid Hermes profile name/);
  assert.throws(() => resolveHermesHomes(["--profile", ","], {}), /cannot be empty/);
  assert.throws(() => resolveHermesHomes(["--profile", "a,b", "--hermes-home", "/x"], {}), /not both/);
});
