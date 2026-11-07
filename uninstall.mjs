// uninstall.mjs — remove the background service, the Hermes adapter and the
// tool access hook of the Hermes Zalo plugin.
// Cross-platform. Optionally wipe saved credentials. Run it through the CLI:
//
//   node bin/cli.mjs uninstall              # everything: the service + the adapter of every profile
//   node bin/cli.mjs uninstall --purge      # also delete the saved credentials (logout)
//   node bin/cli.mjs uninstall --profile <name>[,<name>…]  # remove the adapter from these profiles only
//   node bin/cli.mjs uninstall --hermes-home <dir>         # advanced: an explicit Hermes home
//   node bin/cli.mjs uninstall --hook-only --profile <name>  # remove only the tool access hook
//
// Hermes runs one gateway per host, and the bridge (one Zalo account) is shared
// by every profile, so the service is removed only once no profile uses Zalo,
// and the default profile's host copy of the adapter (see install.mjs
// installHostCopy) stays while a named profile still needs it.

import fs from "node:fs";
import path from "node:path";
import {
  credentialsPath, hasZaloAdapter, hermesHomeSourceLabel, hermesRoot, hostHomeOf, profileHomesUnder, resolveHermesHomes,
} from "./paths.js";
import { removeService } from "./service.js";
import {
  HOOK_FILE, disablePluginInConfig, getPlatformEnabled, removePlatformDisabled, removePreToolHook, setPlatformEnabled,
} from "./hermesConfig.js";

const argv = process.argv.slice(2);
const PURGE = argv.includes("--purge");
// Only the tool access hook: the service, the adapter and the login stay.
const HOOK_ONLY = argv.includes("--hook-only");
if (HOOK_ONLY && PURGE) {
  console.error("\n✗ --hook-only keeps the Zalo login; drop --purge (or --hook-only).");
  process.exit(1);
}
// Resolved before anything is removed, so a bad --profile changes nothing.
let HERMES_HOMES;
try {
  HERMES_HOMES = resolveHermesHomes(argv);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}

// No --profile / --hermes-home: every profile that has the adapter (the whole
// plugin goes). --hook-only keeps its old default (the default profile).
if (HERMES_HOMES[0].source === "default" && !HOOK_ONLY) {
  const found = profileHomesUnder(hermesRoot()).filter((h) => hasZaloAdapter(h.dir));
  if (found.length) HERMES_HOMES = found.map((h) => ({ ...h, source: "scan" }));
}

function log(m) { console.log(m); }

const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : "");
const zaloState = (dir) => getPlatformEnabled(readText(path.join(dir, "config.yaml")), "zalo");

// Profiles under the same Hermes root(s) that keep the adapter after this run:
// Map<root, { named: [home], defaultActive: bool }>.
function usersLeft(targets) {
  const targeted = new Set(targets.map((h) => path.resolve(h.dir)));
  const roots = new Set();
  for (const h of targets) {
    const root = hostHomeOf(h.dir);
    if (root) roots.add(root);
    else if (h.profile === "default") roots.add(path.resolve(h.dir));
  }
  const out = new Map();
  for (const root of roots) {
    const named = profileHomesUnder(root)
      .filter((h) => h.profile !== "default" && !targeted.has(h.dir) && hasZaloAdapter(h.dir));
    // The default profile uses Zalo itself unless its copy is the host copy (platforms.zalo.enabled: false).
    const defaultActive = !targeted.has(root) && hasZaloAdapter(root) && zaloState(root) !== false;
    out.set(root, { named, defaultActive });
  }
  return out;
}
const LEFT = usersLeft(HERMES_HOMES);
const STILL_USED = [...LEFT.values()].flatMap((v) => [...(v.defaultActive ? ["default"] : []), ...v.named.map((h) => h.profile)]);
if (PURGE && STILL_USED.length) {
  console.error(`\n✗ --purge logs the Zalo account out for every profile, but it is still used by: ${STILL_USED.join(", ")}.\n` +
    "  Drop --profile to remove Zalo everywhere, or add those profiles to --profile.");
  process.exit(1);
}

// Mirror of install.mjs installHermesPlugin(): remove the Python adapter from
// <hermes home>/plugins/zalo and drop "zalo-platform" from plugins.enabled. Leaves
// the rest of config.yaml untouched.
function removeHermesPlugin(home) {
  const hermesHome = home.dir;
  log(`Hermes profile: ${home.profile ?? "(custom)"} → ${hermesHome} (${hermesHomeSourceLabel(home)})`);
  if (!fs.existsSync(hermesHome)) {
    log(`• No Hermes home at ${hermesHome}.` +
      (home.source === "default" ? " Pass --profile <name> if the plugin lives in a named profile." : ""));
    return;
  }
  const cfgPath = path.join(hermesHome, "config.yaml");
  // The default profile hosts the shared gateway: while a named profile still
  // uses Zalo it must keep loading the plugin, so only switch Zalo off there.
  const left = LEFT.get(path.resolve(hermesHome));
  if (left?.named.length) {
    keepHostCopy(cfgPath, left.named.map((h) => h.profile));
    removeToolAccessHook(hermesHome, cfgPath);
    return;
  }
  removeAdapter(hermesHome, cfgPath);
  removeToolAccessHook(hermesHome, cfgPath);
}

function keepHostCopy(cfgPath, names) {
  log(`• Kept the adapter: the shared gateway runs here and Zalo is still used by: ${names.join(", ")}.`);
  try {
    const r = setPlatformEnabled(readText(cfgPath), "zalo", false);
    if (r.status !== "already") fs.writeFileSync(cfgPath, r.text);
    log(r.status === "already" ? "✓ Zalo already off in this profile (platforms.zalo.enabled: false)"
      : "✓ Set platforms.zalo.enabled: false: this profile no longer answers on Zalo");
  } catch (e) {
    log(`⚠ Could not edit config.yaml: ${e.message}`);
    log(`  Set platforms.zalo.enabled: false in ${cfgPath} by hand.`);
  }
}

// <home>/plugins/zalo, "zalo-platform" in plugins.enabled and the
// platforms.zalo.enabled: false a host copy carries. Leaves the rest of
// config.yaml untouched.
function removeAdapter(hermesHome, cfgPath) {
  const dest = path.join(hermesHome, "plugins", "zalo");
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    log(`✓ Removed Hermes plugin: ${dest}`);
  } else {
    log("• No Hermes plugin directory to remove.");
  }
  try {
    const { text, removed } = disablePluginInConfig(readText(cfgPath));
    if (removed) {
      fs.writeFileSync(cfgPath, text);
      log('✓ Removed "zalo-platform" from plugins.enabled in config.yaml');
    } else {
      log("• Plugin was not enabled in config.yaml (nothing to remove).");
    }
  } catch (e) {
    log(`⚠ Could not edit config.yaml: ${e.message}`);
    log(`  Manually remove "zalo-platform" from plugins.enabled in ${cfgPath}`);
  }
  try {
    const r = removePlatformDisabled(readText(cfgPath), "zalo");
    if (r.removed) {
      fs.writeFileSync(cfgPath, r.text);
      log("✓ Removed platforms.zalo.enabled: false from config.yaml");
    }
  } catch (e) {
    log(`⚠ Could not edit config.yaml: ${e.message}`);
  }
}

// The default profile's host copy, once no named profile under it needs it.
// Only a pure host copy (Zalo off there) goes; one the default profile uses
// itself is left alone.
function removeUnusedHostCopies() {
  const targeted = new Set(HERMES_HOMES.map((h) => path.resolve(h.dir)));
  for (const [root, left] of LEFT) {
    if (targeted.has(root) || left.named.length || !hasZaloAdapter(root) || zaloState(root) !== false) continue;
    log(`Hermes profile: default → ${root} (${hermesHomeSourceLabel({ source: "host" })}, no longer needed)`);
    removeAdapter(root, path.join(root, "config.yaml"));
  }
}

// Mirror of install.mjs installToolAccessHook(): drop the hook script and its
// hooks.pre_tool_call entry. ZALO_HOOK_* lines in .env are left for a reinstall.
// Returns true when something was removed.
function removeToolAccessHook(hermesHome, cfgPath) {
  const hookDir = path.join(hermesHome, "agent-hooks");
  const dest = path.join(hookDir, HOOK_FILE);
  let removed = false;
  if (fs.existsSync(dest)) {
    removed = true;
    fs.rmSync(dest, { force: true });
    log(`✓ Removed tool access hook: ${dest}`);
    try { fs.rmdirSync(hookDir); } catch { /* not empty: other hooks live there */ }
  }
  if (!fs.existsSync(cfgPath)) return removed;
  try {
    const r = removePreToolHook(fs.readFileSync(cfgPath, "utf-8"));
    if (r.removed) {
      removed = true;
      fs.writeFileSync(cfgPath, r.text);
      log("✓ Removed the tool access hook from hooks.pre_tool_call in config.yaml");
    }
  } catch (e) {
    log(`⚠ Could not edit config.yaml: ${e.message}`);
    log(`  Manually remove the ${HOOK_FILE} entry from hooks.pre_tool_call in ${cfgPath}`);
  }
  return removed;
}

// --hook-only: the hook of one profile, nothing else.
function removeHookOnly(home) {
  log(`Hermes profile: ${home.profile ?? "(custom)"} → ${home.dir} (${hermesHomeSourceLabel(home)})`);
  if (!fs.existsSync(home.dir)) {
    log(`• No Hermes home at ${home.dir}.`);
    return;
  }
  if (!removeToolAccessHook(home.dir, path.join(home.dir, "config.yaml"))) {
    log("• No tool access hook installed in this profile.");
  }
}

function purgeCredentials() {
  const credPath = credentialsPath();
  if (fs.existsSync(credPath)) {
    fs.rmSync(credPath, { force: true });
    log(`✓ Deleted credentials: ${credPath} (you'll need to QR-login again).`);
  } else {
    log("• No saved credentials to delete.");
  }
}

console.log("Hermes Zalo Plugin — uninstaller\n================================");
if (HOOK_ONLY) {
  for (const home of HERMES_HOMES) removeHookOnly(home);
  console.log("\nDone. Service, adapter and login were kept. Restart the shared gateway to apply: hermes gateway restart");
} else {
  for (const home of HERMES_HOMES) removeHermesPlugin(home);
  removeUnusedHostCopies();
  if (STILL_USED.length) {
    log(`• Kept the bridge service: Zalo is still used by: ${STILL_USED.join(", ")}.`);
  } else {
    const svc = removeService();
    log(`${svc.removed ? "✓" : "•"} ${svc.message}.`);
  }
  if (PURGE) purgeCredentials();
  console.log("\nDone. (The bridge files themselves were left in place.)");
  console.log("Restart the shared gateway (it serves every profile): hermes gateway restart");
}
