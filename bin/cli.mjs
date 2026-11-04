#!/usr/bin/env node
// bin/cli.mjs — CLI entry point for the hermes-zalo-plugin npm package.
//
//   hermes-zalo-plugin setup       # deps already installed by npm; login + service
//   hermes-zalo-plugin login       # QR login (--force to re-scan)
//   hermes-zalo-plugin start       # run the bridge in the foreground
//   hermes-zalo-plugin restart     # restart the background service (reloads bridge.env)
//   hermes-zalo-plugin stop        # stop the background service (kept installed)
//   hermes-zalo-plugin status      # show bridge health + where data lives
//   hermes-zalo-plugin uninstall   # remove background service (--purge to wipe creds)
//
// Data (credentials, QR, undo-cache) lives in ~/.hermes-zalo/ by default
// (override with ZALO_DATA_DIR), so a global install survives package updates.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, bridgeEnvPath, loadBridgeEnv } from "../paths.js";
import { restartService, serviceInstalled, serviceState, stopService } from "../service.js";

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
      console.log("    Fix: hermes-zalo-plugin login   (reuses saved cookie, else shows a QR;");
      console.log("         the running bridge picks the new session up automatically)");
    }
  } catch {
    console.log(`Bridge: NOT running (no response on http://${host}:${port}).`);
    if (serviceInstalled()) console.log("  Start it with: hermes-zalo-plugin restart");
    else console.log("  Start it with: hermes-zalo-plugin start   (or 'setup' for a background service)");
  }
}

// Restart the background service so it re-reads bridge.env (starts it if it
// was stopped). Each platform's service manager does the work.
function restart() {
  const r = restartService();
  if (!r.ok) {
    console.error(`✗ Could not restart the service: ${r.message}.`);
    console.error("  Install it with: hermes-zalo-plugin setup --service-only   (or run 'start' in the foreground)");
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
  console.log("✓ Bridge service stopped. Start it again with: hermes-zalo-plugin restart");
  if (process.platform !== "linux") console.log("  (It also starts again at your next login.)");
}

function banner() {
  const tty = process.stdout.isTTY;
  const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const blue = (s) => c("38;5;33", s);
  const cyan = (s) => c("36", s);
  const dim = (s) => c("2", s);
  console.log(
    "\n" +
    blue("  ╦ ╦┌─┐┬─┐┌┬┐┌─┐┌─┐  ") + cyan("╔═╗┌─┐┬  ┌─┐") + "\n" +
    blue("  ╠═╣├┤ ├┬┘│││├┤ └─┐  ") + cyan("╔═╝├─┤│  │ │") + "\n" +
    blue("  ╩ ╩└─┘┴└─┴ ┴└─┘└─┘  ") + cyan("╚═╝┴ ┴┴─┘└─┘") + "\n" +
    dim("  Hermes × Zalo plugin") + "\n" +
    dim("  chat with your Hermes agent from Zalo") + "\n",
  );
}

function help() {
  banner();
  console.log(`Usage: hermes-zalo-plugin <command> [options]

Commands:
  setup        Log in (QR) if needed and install a background auto-start service
               --hermes-home <path>   copy the adapter into this Hermes profile
                                      instead of ~/.hermes (also reads HERMES_HOME)
  login        QR login only (--force to re-scan an existing session)
  start        Run the bridge in the foreground (Ctrl-C to stop)
  restart      Restart (or start) the background service; applies bridge.env
  stop         Stop the background service (stays installed; 'restart' brings it back)
  status       Show bridge health and the data directory
  uninstall    Remove the background service (--purge also deletes credentials)
               --hermes-home <path>   remove the adapter from that Hermes profile
  help         Show this message

Data lives in ~/.hermes-zalo/ (override with ZALO_DATA_DIR). Bridge settings
(token, action policy) are read from ~/.hermes-zalo/bridge.env, which
'hermes gateway setup' writes for you.
The Hermes adapter is installed into ~/.hermes only when that directory already
exists. For another profile:  hermes-zalo-plugin setup --hermes-home <path>
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
