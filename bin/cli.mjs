#!/usr/bin/env node
// bin/cli.mjs — the single entry point of the Hermes Zalo plugin. Run it from
// the git checkout:
//
//   node bin/cli.mjs setup       # deps → login → service → Hermes adapter
//   node bin/cli.mjs login       # QR login (--force to re-scan)
//   node bin/cli.mjs start       # run the bridge in the foreground
//   node bin/cli.mjs restart     # restart the background service (reloads bridge.env)
//   node bin/cli.mjs stop        # stop the background service (kept installed)
//   node bin/cli.mjs status      # show bridge health + where data lives
//   node bin/cli.mjs uninstall   # remove the service and adapter (--purge to wipe creds)
//
// Data (credentials, QR, undo-cache) lives in ~/.hermes-zalo/ by default
// (override with ZALO_DATA_DIR), so it survives `git pull` and re-clones.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, bridgeEnvPath, loadBridgeEnv } from "../paths.js";
import { restartService, serviceInstalled, serviceState, stopService } from "../service.js";
import { CLI, banner } from "../ui.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath;
const [, , cmd, ...rest] = process.argv;

loadBridgeEnv(); // pick up the port the service uses

function runNode(script, args = []) {
  const r = spawnSync(NODE, [path.join(ROOT, script), ...args], {
    stdio: "inherit",
    cwd: ROOT,
  });
  process.exit(r.status ?? 0);
}

async function status() {
  const port = process.env.ZALO_PLUGIN_PORT || "8787";
  const host = process.env.ZALO_PLUGIN_HOST || "127.0.0.1";
  console.log(`Data directory: ${dataDir()}`);
  console.log(`Bridge settings: ${bridgeEnvPath()}`);
  console.log(`Service: ${serviceState()}`);
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const j = await res.json();
    console.log(`Bridge: RUNNING on http://${host}:${port}`);
    console.log(
      `  loggedIn=${j.loggedIn} sessionDead=${j.sessionDead} ownId=${j.ownId || "-"} ownName=${j.ownName || "-"}`,
    );
    if (j.sessionDead || !j.loggedIn) {
      console.log(`  ⚠ not logged in${j.sessionDead ? ` (session dead: ${j.sessionDeadReason || "unknown"})` : ""}.`);
      console.log(`    Fix: ${CLI} login   (reuses saved cookie, else shows a QR;`);
      console.log("         the running bridge picks the new session up automatically)");
    }
  } catch {
    console.log(`Bridge: NOT running (no response on http://${host}:${port}).`);
    if (serviceInstalled()) console.log(`  Start it with: ${CLI} restart`);
    else console.log(`  Start it with: ${CLI} start   (or 'setup' for a background service)`);
  }
}

// Restart the background service so it re-reads bridge.env (starts it if it
// was stopped). Each platform's service manager does the work.
function restart() {
  const r = restartService();
  if (!r.ok) {
    console.error(`✗ Could not restart the service: ${r.message}.`);
    console.error(`  Install it with: ${CLI} setup --service-only   (or run 'start' in the foreground)`);
    process.exit(1);
  }
  console.log("✓ Bridge service restarted.");
}

// Stop the background service but keep it registered (use 'uninstall' to remove).
function stop() {
  const r = stopService();
  if (!r.ok) {
    console.error(`✗ Could not stop the service: ${r.message}.`);
    if (!serviceInstalled()) console.error("  (A bridge started with 'start' stops with Ctrl-C.)");
    process.exit(1);
  }
  console.log(`✓ Bridge service stopped. Start it again with: ${CLI} restart`);
  if (process.platform !== "linux") console.log("  (It also starts again at your next login.)");
}

function help() {
  banner();
  console.log(`Usage: ${CLI} <command> [options]

Commands:
  setup        Log in (QR) if needed and install a background auto-start service
               -p, --profile <names>  Hermes profile(s) to install the adapter into, comma-separated
                                      (default = ~/.hermes, <name> = ~/.hermes/profiles/<name>;
                                      also reads HERMES_PROFILE)
               --service-only         only (re)install the service + adapter (after an update)
               --no-service           skip the background service
               --relogin              force a new QR scan
               --hermes-home <dir>    advanced: explicit Hermes home (also reads HERMES_HOME)
               --with-hook            also install the tool access hook
               --hook-owner <uid>     hook + owner uid(s) in the profile .env
               --hook-mode <m>        owner mode: read | full-dm | full
  login        QR login only (--force to re-scan an existing session)
  start        Run the bridge in the foreground (Ctrl-C to stop)
  restart      Restart (or start) the background service; applies bridge.env
  stop         Stop the background service (stays installed; 'restart' brings it back)
  status       Show bridge health and the data directory
  uninstall    Remove the service, adapter and tool access hook (--purge also deletes credentials)
               -p, --profile <names>  remove the adapter and hook from these Hermes profiles
  help         Show this message

Data lives in ~/.hermes-zalo/ (override with ZALO_DATA_DIR). Bridge settings
(token, action policy) are read from ~/.hermes-zalo/bridge.env, which
'hermes gateway setup' writes for you.
The Hermes adapter goes into the default profile (~/.hermes) only when it already
exists. For named profiles:  ${CLI} setup --profile <name>[,<name>…]
After 'setup', register it in Hermes:  hermes gateway setup  → choose Zalo.`);
}

switch (cmd) {
  case "setup":
    runNode("install.mjs", rest);
    break;
  case "login":
    runNode("login.mjs", rest);
    break;
  case "start":
    runNode("server.js", rest);
    break;
  case "restart":
    restart();
    break;
  case "stop":
    stop();
    break;
  case "uninstall":
    runNode("uninstall.mjs", rest);
    break;
  case "status":
    await status();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    help();
    break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    help();
    process.exit(1);
}
