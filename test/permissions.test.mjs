import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ACTION_GROUP, DEFAULT_GROUPS, SENSITIVE_ACTIONS, createPolicy } from "../permissions.js";

test("default policy allows read/send/interact only", () => {
  const p = createPolicy({});
  assert.deepEqual([...p.groups].sort(), [...DEFAULT_GROUPS].sort());
  assert.equal(p.check("sendMessage").ok, true);
  assert.equal(p.check("getAllFriends").ok, true);
  assert.equal(p.check("createGroup").ok, false); // manage
  assert.equal(p.check("deleteMessage").ok, false); // destructive
});

test("session secrets are blocked by default and under 'all'", () => {
  for (const env of [{}, { ZALO_ALLOWED_ACTION_GROUPS: "all", ZALO_ALLOW_DESTRUCTIVE: "true" }]) {
    const p = createPolicy(env);
    for (const m of SENSITIVE_ACTIONS) {
      assert.equal(p.check(m).ok, false, `${m} must be blocked with ${JSON.stringify(env)}`);
      assert.ok(!p.describe().allowedActions.includes(m));
    }
  }
});

test("sensitive actions only pass when named explicitly", () => {
  const p = createPolicy({ ZALO_ALLOWED_ACTIONS: "getCookie" });
  assert.equal(p.check("getCookie").ok, true);
  assert.equal(p.check("getContext").ok, false);
});

test("destructive needs the explicit opt-in even under 'all'", () => {
  assert.equal(createPolicy({ ZALO_ALLOWED_ACTION_GROUPS: "all" }).check("disperseGroup").ok, false);
  assert.equal(
    createPolicy({ ZALO_ALLOWED_ACTION_GROUPS: "all", ZALO_ALLOW_DESTRUCTIVE: "true" }).check("disperseGroup").ok,
    true,
  );
});

test("deny beats allow; unknown and inherited names are rejected", () => {
  const p = createPolicy({ ZALO_ALLOWED_ACTIONS: "sendMessage", ZALO_DENIED_ACTIONS: "sendMessage" });
  assert.equal(p.check("sendMessage").ok, false);
  for (const m of ["constructor", "toString", "__proto__", "hasOwnProperty", "noSuchApi"]) {
    assert.equal(createPolicy({ ZALO_ALLOWED_ACTION_GROUPS: "all" }).check(m).ok, false, m);
  }
});

test("custom whitelist mode (no groups) allows only the listed actions", () => {
  const p = createPolicy({ ZALO_ALLOWED_ACTION_GROUPS: "none", ZALO_ALLOWED_ACTIONS: "sendMessage" });
  assert.equal(p.groups.size, 0);
  assert.equal(p.check("sendMessage").ok, true);
  assert.equal(p.check("getAllFriends").ok, false);
});

test("Python adapter's action map matches permissions.js", () => {
  const py = fs.readFileSync(new URL("../hermes-plugin/adapter.py", import.meta.url), "utf-8");
  const block = py.split("_ACTION_GROUP = {")[1].split("\n}")[0];
  const pyMap = Object.fromEntries([...block.matchAll(/"(\w+)":\s*"(\w+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(pyMap, ACTION_GROUP);
  const pySensitive = py.match(/_SENSITIVE_ACTIONS = \{([^}]*)\}/)[1];
  assert.deepEqual([...pySensitive.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(), [...SENSITIVE_ACTIONS].sort());
});

test("every zca-js API method has a permission group", () => {
  // Methods the installed zca-js binds on its API class (this.x = xFactory(...)).
  // `custom` registers new API functions at runtime, so it is deliberately unmapped
  // (and therefore denied as an unknown action).
  const src = fs.readFileSync(new URL("../node_modules/zca-js/dist/apis.js", import.meta.url), "utf-8");
  const bound = [...src.matchAll(/this\.(\w+) = \w+Factory\(/g)].map((m) => m[1]).filter((m) => m !== "custom");
  assert.ok(bound.length > 100, "could not parse zca-js API list");
  const missing = bound.filter((m) => !Object.hasOwn(ACTION_GROUP, m));
  assert.deepEqual(missing, [], `zca-js methods missing from ACTION_GROUP: ${missing.join(", ")}`);
  assert.equal(createPolicy({ ZALO_ALLOWED_ACTION_GROUPS: "all", ZALO_ALLOW_DESTRUCTIVE: "true" }).check("custom").ok, false);
});
