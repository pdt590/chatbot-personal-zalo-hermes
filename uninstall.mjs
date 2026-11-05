// uninstall.mjs — remove the background service, the Hermes adapter and the
// tool access hook of the Hermes Zalo plugin.
// Cross-platform. Optionally wipe saved credentials. Run it through the CLI:
//
//   node bin/cli.mjs uninstall              # stop + remove the auto-start service
//   node bin/cli.mjs uninstall --purge      # also delete the saved credentials (logout)
//   node bin/cli.mjs uninstall --profile <name>[,<name>…]  # remove the adapter from these profiles
//   node bin/cli.mjs uninstall --hermes-home <dir>         # advanced: an explicit Hermes home

import fs from "node:fs";
import path from "node:path";
import { credentialsPath, hermesHomeSourceLabel, resolveHermesHomes } from "./paths.js";
import { removeService } from "./service.js";
import { HOOK_FILE, disablePluginInConfig, removePreToolHook } from "./hermesConfig.js";

const argv = process.argv.slice(2);
const PURGE = argv.includes("--purge");
// Resolved before anything is removed, so a bad --profile changes nothing.
let HERMES_HOMES;
try {
  HERMES_HOMES = resolveHermesHomes(argv);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}

function log(m) { console.log(m); }

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
  const dest = path.join(hermesHome, "plugins", "zalo");
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    log(`✓ Removed Hermes plugin: ${dest}`);
  } else {
    log("• No Hermes plugin directory to remove.");
  }

  const cfgPath = path.join(hermesHome, "config.yaml");
  try {
    const { text, removed } = disablePluginInConfig(fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "");
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
  removeToolAccessHook(hermesHome, cfgPath);
}

// Mirror of install.mjs installToolAccessHook(): drop the hook script and its
// hooks.pre_tool_call entry. ZALO_HOOK_* lines in .env are left for a reinstall.
function removeToolAccessHook(hermesHome, cfgPath) {
  const hookDir = path.join(hermesHome, "agent-hooks");
  const dest = path.join(hookDir, HOOK_FILE);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { force: true });
    log(`✓ Removed tool access hook: ${dest}`);
    try { fs.rmdirSync(hookDir); } catch { /* not empty: other hooks live there */ }
  }
  if (!fs.existsSync(cfgPath)) return;
  try {
    const r = removePreToolHook(fs.readFileSync(cfgPath, "utf-8"));
    if (r.removed) {
      fs.writeFileSync(cfgPath, r.text);
      log("✓ Removed the tool access hook from hooks.pre_tool_call in config.yaml");
    }
  } catch (e) {
    log(`⚠ Could not edit config.yaml: ${e.message}`);
    log(`  Manually remove the ${HOOK_FILE} entry from hooks.pre_tool_call in ${cfgPath}`);
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
const svc = removeService();
log(`${svc.removed ? "✓" : "•"} ${svc.message}.`);
for (const home of HERMES_HOMES) removeHermesPlugin(home);
if (PURGE) purgeCredentials();
console.log("\nDone. (The bridge files themselves were left in place.)");
