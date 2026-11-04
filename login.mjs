// login.mjs — standalone QR login for the Zalo plugin.
// Cross-platform (macOS / Linux / Windows). Run once (or with --force to
// re-login). Prints the QR in the terminal AND saves a PNG, then persists
// credentials to the data dir (~/.hermes-zalo by default) so the bridge
// starts without QR.
//
//   node login.mjs            # login if not already logged in
//   node login.mjs --force    # ignore saved credentials, re-scan QR

import fs from "node:fs";
import { ZaloClient } from "./zaloClient.js";
import { credentialsPath, qrPath, loadBridgeEnv } from "./paths.js";
import { serviceInstalled } from "./service.js";

loadBridgeEnv(); // same port/token the bridge service uses

const force = process.argv.includes("--force") || process.argv.includes("--relogin");

const CREDENTIALS_PATH = credentialsPath();
const QR_PATH = qrPath();

// The QR (scannable ASCII + live countdown + auto-refresh) is rendered by
// ZaloClient.login() itself when stdout is a TTY, so this script just drives
// the flow.

const BRIDGE = `http://${process.env.ZALO_PLUGIN_HOST || "127.0.0.1"}:${process.env.ZALO_PLUGIN_PORT || "8787"}`;

// GET /health of a running bridge, or null when none is reachable.
async function probeBridge() {
  try {
    const res = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // no bridge running
  }
}

// If a bridge is already running and logged in we must NOT open a second Zalo
// connection (Zalo kicks the old one — DuplicateConnection 3000).
async function bridgeAlreadyLoggedIn() {
  const h = await probeBridge();
  return !!(h && h.loggedIn && !h.sessionDead);
}

// A bridge that is running but logged out keeps its old (dead) session until
// told otherwise. Ask it to reload the credentials we just saved, so the user
// does not have to restart the service.
async function reloadRunningBridge() {
  if (!(await probeBridge())) {
    // setup starts the service itself right after this script.
    if (!process.env.HZP_FROM_SETUP && serviceInstalled()) {
      console.log("• The bridge service is not running. Start it:  hermes-zalo-plugin restart");
    }
    return;
  }
  const headers = { "Content-Type": "application/json" };
  if (process.env.ZALO_PLUGIN_TOKEN) headers["x-bridge-token"] = process.env.ZALO_PLUGIN_TOKEN;
  try {
    const res = await fetch(`${BRIDGE}/relogin`, {
      method: "POST",
      headers,
      body: JSON.stringify({ forceQR: false }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const h = await probeBridge();
      if (h && h.loggedIn) {
        console.log("✓ The running bridge picked up the new session.");
        return;
      }
    }
    console.log("⚠ The running bridge has not logged in yet; check `hermes-zalo-plugin status`.");
  } catch (e) {
    console.log(`⚠ Could not ask the running bridge to reload (${e.message}). Restart it: hermes-zalo-plugin restart`);
  }
}

async function main() {
  // 0) If a bridge is already up and logged in, do nothing — opening a second
  //    session would get this account kicked.
  if (!force && (await bridgeAlreadyLoggedIn())) {
    console.log("✓ A bridge is already running and logged in — nothing to do.");
    console.log("  (Use --force only if you really want to re-scan; stop the bridge first to avoid a duplicate-session kick.)");
    process.exit(0);
  }
  if (force && (await bridgeAlreadyLoggedIn())) {
    console.error("✗ A bridge is currently running and logged in.");
    console.error("  Stop it first:  hermes-zalo-plugin stop   (then login --force, then restart),");
    console.error("  or do it in one step:  hermes-zalo-plugin setup --relogin");
    console.error("  Re-logging in while it runs would kick the live session (DuplicateConnection).");
    process.exit(1);
  }

  if (!force && fs.existsSync(CREDENTIALS_PATH)) {
    // No live bridge, but we have saved credentials — verify they still work.
    const probe = new ZaloClient({ credentialsPath: CREDENTIALS_PATH, qrPath: QR_PATH });
    try {
      // cookieOnly: a dead cookie must fall through to the QR flow below, not
      // start a QR login inside this probe.
      await probe.login({ forceQR: false, cookieOnly: true });
      console.log(`✓ Already logged in (ownId=${probe.ownId}). Use --force to re-scan.`);
      try { await probe.shutdown?.(); } catch {}
      await reloadRunningBridge(); // a logged-out bridge can reuse the working cookie
      process.exit(0);
    } catch {
      console.log("Saved credentials no longer work — starting a fresh QR login…");
    }
  }

  const client = new ZaloClient({ credentialsPath: CREDENTIALS_PATH, qrPath: QR_PATH });

  console.log("Starting Zalo QR login…");
  try {
    const res = await client.login({ forceQR: true });
    // login() resolves once the phone confirms; credentials are already saved.
    console.log(`\n✓ Logged in via ${res.method}. ownId=${client.ownId}`);
    console.log(`✓ Credentials saved to ${CREDENTIALS_PATH}`);
    // Close our own connection before the bridge reconnects with the same cookie.
    try { await client.shutdown?.(); } catch {}
    await reloadRunningBridge();
    console.log("\nNext step: run  hermes gateway setup  → choose Zalo.");
    process.exit(0);
  } catch (e) {
    console.error("\n✗ Login failed:", e?.message || e);
    process.exit(1);
  }
}

main();
