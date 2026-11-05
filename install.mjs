// install.mjs — one-shot, cross-platform installer for the Hermes Zalo plugin.
// Runs the same on macOS, Linux, and Windows (Node drives everything; only the
// service-manager step branches per-OS). Run it through the CLI:
//
//   node bin/cli.mjs setup                  # full setup: deps → login → background service
//   node bin/cli.mjs setup --no-service     # deps → login only (run `start` yourself)
//   node bin/cli.mjs setup --relogin        # force a fresh QR login
//   node bin/cli.mjs setup --service-only   # (re)install just the service + adapter
//   node bin/cli.mjs setup --profile <name>[,<name>…]
//                                           # install the adapter into these Hermes profiles
//                                           # (~/.hermes/profiles/<name>; "default" = ~/.hermes)
//   node bin/cli.mjs setup --hermes-home <dir>   # advanced: an explicit Hermes home directory
//   node bin/cli.mjs setup --with-hook      # also install the tool-access hook
//   node bin/cli.mjs setup --hook-owner <uid> [--hook-mode read|full-dm|full]
//                                           # hook + owner settings in the profile .env
//
// After this, the end-user only needs:  hermes gateway setup  → choose Zalo.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hermesHomeSourceLabel, logDir, resolveHermesHomes } from "./paths.js";
import {
  LABEL, WIN_TASK, plistPath, restartService, serviceInstalled, stopService, unitPath, winLauncherPath,
} from "./service.js";
import {
  HOOK_FILE, addPreToolHook, enablePlatformToolsets, enablePluginInConfig, readProvidedToolsets, setEnvVar,
} from "./hermesConfig.js";
import { CLI, banner } from "./ui.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const NO_SERVICE = has("--no-service");
const RELOGIN = has("--relogin") || has("--force");
const SERVICE_ONLY = has("--service-only");
// `--name value` or `--name=value`; undefined when absent.
function flag(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      const v = argv[i + 1];
      if (v == null || v.startsWith("-")) die(`${name} requires a value`);
      return v;
    }
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}
const HOOK_OWNER = flag("--hook-owner");
const HOOK_MODE = flag("--hook-mode");
const WITH_HOOK = has("--with-hook") || HOOK_OWNER != null || HOOK_MODE != null;
if (HOOK_OWNER != null && !/^\d+(,\d+)*$/.test(HOOK_OWNER.replace(/\s/g, ""))) {
  die("--hook-owner takes Zalo uid(s): digits, comma-separated");
}
if (HOOK_MODE != null && !["read", "full-dm", "full"].includes(HOOK_MODE)) {
  die("--hook-mode must be read, full-dm or full");
}

const PLATFORM = process.platform; // 'darwin' | 'linux' | 'win32'

// Where the Hermes adapter goes (one or more profiles). Resolved up front so a
// typo in --profile fails before the QR login and service steps.
let HERMES_HOMES;
try {
  HERMES_HOMES = resolveHermesHomes(argv);
} catch (e) {
  die(e.message);
}
// A named profile is created by Hermes (it seeds config, .env, skills…); a
// missing one is almost always a typo, so stop instead of inventing it.
for (const home of HERMES_HOMES) {
  if ((home.source === "profile" || home.source === "env-profile")
      && home.profile !== "default" && !fs.existsSync(home.dir)) {
    die(`Hermes profile '${home.profile}' not found at ${home.dir}.\n` +
      `  Create it first:  hermes profile create ${home.profile}\n` +
      "  (list existing ones with: hermes profile list)");
  }
}

// The service must outlive Node upgrades. process.execPath often points into a
// versioned directory that the package manager deletes on the next update
// (snap: /snap/node/<rev>/…, Homebrew: …/Cellar/node/<ver>/…), after which
// the service fails to start (systemd status=203/EXEC). Use the stable alias.
function stableNodeBin(exe = process.execPath) {
  const snap = exe.match(/^\/snap\/([^/]+)\/x?\d+\/(.+)$/);
  if (snap) {
    const current = `/snap/${snap[1]}/current/${snap[2]}`;
    if (fs.existsSync(current)) return current;
  }
  const brew = exe.match(/^(.*)\/Cellar\/node(?:@[^/]+)?\/[^/]+\/bin\/node$/);
  if (brew) {
    const linked = `${brew[1]}/bin/node`;
    if (fs.existsSync(linked)) return linked;
  }
  return exe;
}
const NODE_BIN = stableNodeBin();
const SERVER_JS = path.join(__dirname, "server.js");
const CLI_JS = path.join(__dirname, "bin", "cli.mjs");

// Data-location overrides the user ran setup with. The service manager starts
// the bridge with a clean environment, so without these it would look for
// credentials/bridge.env in the default ~/.hermes-zalo and miss the login.
const PATH_ENV_KEYS = [
  "ZALO_DATA_DIR", "ZALO_BRIDGE_ENV", "ZALO_CREDENTIALS_PATH",
  "ZALO_QR_PATH", "ZALO_CLIMSG_DIR", "ZALO_LOG_DIR",
];
function serviceEnv() {
  const out = {};
  for (const k of PATH_ENV_KEYS) {
    const v = (process.env[k] || "").trim();
    if (v) out[k] = path.resolve(v);
  }
  return out;
}
const xmlEscape = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function log(msg) { console.log(msg); }
function step(n, msg) { console.log(`\n[${n}] ${msg}`); }
function die(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: __dirname, ...opts });
  if (r.status !== 0) die(`command failed: ${cmd} ${args.join(" ")}`);
  return r;
}

// ── 0. Prerequisites ────────────────────────────────────────────────────────
function checkPrereqs() {
  // Node version
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 18) {
    die(
      `Node >= 18 required (found ${process.version}).\n` +
      `  Install Node:\n` +
      `    macOS:    brew install node   (or https://nodejs.org)\n` +
      `    Linux:    use nvm (https://github.com/nvm-sh/nvm) or your distro's nodejs package\n` +
      `    Windows:  https://nodejs.org (LTS installer)`
    );
  }
  log(`✓ Node ${process.version}`);
}

// ── 1. Install dependencies (pulls zca-js from npm — no build, no bun) ───────
function installDeps() {
  // Only run `npm install` when the checkout is missing node_modules.
  if (fs.existsSync(path.join(__dirname, "node_modules", "zca-js"))) {
    log("✓ Dependencies already present (skipping npm install)");
    return;
  }
  step(1, "Installing dependencies (npm install)…");
  // npm is cross-platform; on Windows the shell needs npm.cmd via shell:true.
  const npmCmd = PLATFORM === "win32" ? "npm.cmd" : "npm";
  const shell = PLATFORM === "win32";
  // npm ships with Node, but some minimal installs strip it.
  if (spawnSync(npmCmd, ["--version"], { stdio: "ignore", shell }).status !== 0) {
    die(
      "npm not found on PATH. It normally ships with Node.js.\n" +
      "  Reinstall Node from https://nodejs.org, or ensure npm is on your PATH."
    );
  }
  run(npmCmd, ["install", "--no-audit", "--no-fund"], { shell });
  log("✓ Dependencies installed");
}

// ── 2. Log in (QR) unless we already have working credentials ────────────────
function login({ restartOnFailure = false } = {}) {
  step(2, "Zalo login…");
  const args = [path.join(__dirname, "login.mjs")];
  if (RELOGIN) args.push("--force");
  const r = spawnSync(NODE_BIN, args, {
    stdio: "inherit",
    cwd: __dirname,
    env: { ...process.env, HZP_FROM_SETUP: !NO_SERVICE || restartOnFailure ? "1" : "" },
  });
  if (r.status !== 0) {
    // Don't leave the user with no bridge at all: bring the old one back.
    if (restartOnFailure) restartService();
    die(`Zalo login failed (see above). Re-run: ${CLI} setup --relogin`);
  }
}

// ── 3. Background service (per-OS) ───────────────────────────────────────────
function installServiceDarwin() {
  const plist = plistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  const logs = logDir();
  fs.mkdirSync(logs, { recursive: true });
  const env = Object.entries(serviceEnv());
  const envXml = env.length
    ? `  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${k}</key><string>${xmlEscape(v)}</string>`).join("\n")}
  </dict>
`
    : "";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SERVER_JS}</string>
  </array>
  <key>WorkingDirectory</key><string>${__dirname}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
${envXml}  <key>StandardOutPath</key><string>${path.join(logs, "bridge.out.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logs, "bridge.err.log")}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plist, xml);
  // reload (ignore failures if not yet loaded)
  spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
  // `load` starts it (RunAtLoad) and picks up the new plist and code.
  run("launchctl", ["load", plist]);
  log(`✓ launchd service installed: ${plist}`);
  log("  Manage: launchctl unload/load the plist above.");
}

function installServiceLinux() {
  const unitFile = unitPath();
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  const unit = `[Unit]
Description=Hermes Zalo Plugin
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${__dirname}
${Object.entries(serviceEnv()).map(([k, v]) => `Environment="${k}=${v}"\n`).join("")}ExecStart=${NODE_BIN} ${SERVER_JS}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitFile, unit);
  const sysctl = (args) => spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (spawnSync("systemctl", ["--version"], { stdio: "ignore" }).status !== 0) {
    log(`⚠ systemd not available. Unit written to ${unitFile}; start the bridge manually with: ${CLI} start`);
    return;
  }
  sysctl(["daemon-reload"]);
  // enable + restart (not `enable --now`): on a re-run after an update an
  // already-running bridge must be restarted to load the new code.
  const ok = sysctl(["enable", `${LABEL}.service`]).status === 0 && restartService().ok;
  if (!ok) {
    log(`⚠ Unit written to ${unitFile}, but systemd --user could not start it.`);
    log("  (Common over SSH without a user session: run `loginctl enable-linger $USER` and re-login.)");
    log(`  Start the bridge manually meanwhile: ${CLI} start`);
    return;
  }
  log(`✓ systemd user service installed & started: ${unitFile}`);
  log(`  Manage: systemctl --user status/restart/stop ${LABEL}`);
  log("  Tip: run `loginctl enable-linger $USER` so it runs without an active login session.");
}

function installServiceWindows() {
  // Scheduled Task that runs at logon (no auto-restart on crash). Avoids needing
  // nssm/admin service install. Uses schtasks (present on all Windows).
  // A tiny launcher sets cwd + data-location env and captures logs (schtasks
  // /TR has none of that and a ~260 char limit).
  const logs = logDir();
  fs.mkdirSync(logs, { recursive: true });
  const launcher = winLauncherPath();
  const envLines = Object.entries(serviceEnv()).map(([k, v]) => `set "${k}=${v}"`);
  fs.writeFileSync(launcher, [
    "@echo off",
    `cd /d "${__dirname}"`,
    ...envLines,
    `"${NODE_BIN}" "${SERVER_JS}" >> "${path.join(logs, "bridge.out.log")}" 2>> "${path.join(logs, "bridge.err.log")}"`,
    "",
  ].join("\r\n"));
  const cmd = `"${launcher}"`;
  const args = [
    "/Create", "/F",
    "/SC", "ONLOGON",
    "/TN", WIN_TASK,
    "/TR", cmd,
    "/RL", "LIMITED",
  ];
  const r = spawnSync("schtasks", args, { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    log(`⚠ Could not register a Scheduled Task automatically. Start the bridge manually with: ${CLI} start`);
    log("  Or create a task that runs at logon with command:");
    log(`    ${cmd}`);
    return;
  }
  log(`✓ Scheduled Task '${WIN_TASK}' registered (runs at logon).`);
  // Start it now too, otherwise the bridge is down until the next logon.
  if (restartService().ok) log("✓ Bridge started.");
  else log(`⚠ Could not start it now. Run:  ${CLI} restart`);
  log(`  Manage:     Task Scheduler → ${WIN_TASK}`);
}

function installService() {
  step(3, "Installing background service (auto-start + auto-restart)…");
  if (PLATFORM === "darwin") return installServiceDarwin();
  if (PLATFORM === "linux") return installServiceLinux();
  if (PLATFORM === "win32") return installServiceWindows();
  log(`⚠ Unsupported platform '${PLATFORM}' for auto-service. Run the bridge manually: ${CLI} start`);
}

// ── 4. Install the Hermes-side plugin so `hermes gateway` sees Zalo ──────────
// The bridge (Node) and the Hermes adapter (Python) are separate halves. The
// adapter lives under hermes-plugin/ in this package; copy it into the user's
// Hermes plugin dir (<hermes home>/plugins/zalo) and add "zalo" to plugins.enabled
// so the (untrusted) user plugin is allowed to load.
function installHermesPlugins() {
  step(4, "Installing the Hermes plugin (so `hermes gateway` sees Zalo)…");
  const src = path.join(__dirname, "hermes-plugin");
  if (!fs.existsSync(src)) {
    log("⚠ hermes-plugin/ not found in the checkout — skipping (bridge still works standalone).");
    return;
  }
  for (const home of HERMES_HOMES) installHermesPlugin(src, home);
}

function installHermesPlugin(src, home) {
  const hermesHome = home.dir;
  log(`Hermes profile: ${home.profile ?? "(custom)"} → ${hermesHome} (${hermesHomeSourceLabel(home)})`);
  if (!fs.existsSync(hermesHome)) {
    // Never create the default home: Hermes may simply not be installed yet.
    if (home.source === "default") {
      log(`⚠ Hermes home not found at ${hermesHome}.`);
      log("  Skipping plugin install. Pass --profile <name> for a named Hermes profile,");
      log(`  or install Hermes and re-run: ${CLI} setup --service-only`);
      return;
    }
    fs.mkdirSync(hermesHome, { recursive: true });
  }
  const dest = path.join(hermesHome, "plugins", "zalo");
  fs.mkdirSync(dest, { recursive: true });
  // Files only: a checkout has hermes-plugin/__pycache__/, and copyFileSync on
  // a directory throws EISDIR. Python rebuilds bytecode itself.
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (!ent.isFile() || ent.name.endsWith(".pyc")) continue;
    fs.copyFileSync(path.join(src, ent.name), path.join(dest, ent.name));
  }
  // Drop bytecode left by an older adapter version.
  fs.rmSync(path.join(dest, "__pycache__"), { recursive: true, force: true });
  // Tell the adapter how to run this checkout's CLI (`hermes gateway setup`
  // offers to log in / start / restart the bridge).
  fs.writeFileSync(path.join(dest, "bridge_cli.json"),
    JSON.stringify({ node: NODE_BIN, cli: CLI_JS }, null, 2) + "\n");
  log(`✓ Plugin copied to ${dest}`);

  // Enable the plugin in config.yaml (plugins.enabled must contain "zalo-platform").
  const cfgPath = path.join(hermesHome, "config.yaml");
  try {
    const before = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "";
    const { text, status } = enablePluginInConfig(before);
    if (status !== "already") fs.writeFileSync(cfgPath, text);
    log(status === "already" ? "✓ Plugin already enabled in config.yaml"
        : status === "added" ? '✓ Added "zalo-platform" to plugins.enabled in config.yaml'
        : '✓ Created plugins.enabled with "zalo-platform" in config.yaml');
  } catch (e) {
    log(`⚠ Could not auto-enable the plugin: ${e.message}`);
    log(`  Manually add "zalo-platform" under plugins.enabled in ${cfgPath}`);
  }
  enablePluginToolsets(cfgPath, path.join(src, "plugin.yaml"));
  installToolAccessHook(home, cfgPath);
}

// ── 5. Optional pre_tool_call hook limiting what Zalo users can make the agent do ─
// Opt-in (--with-hook / --hook-owner / --hook-mode): with no owner set it blocks
// every tool for Zalo users. Once installed, re-runs keep it up to date.
function installToolAccessHook({ dir: hermesHome, profile }, cfgPath) {
  const src = path.join(__dirname, "hooks", HOOK_FILE);
  const dest = path.join(hermesHome, "agent-hooks", HOOK_FILE);
  const installed = fs.existsSync(dest);
  if (!WITH_HOOK && !installed) {
    log("• Tool access hook not installed (optional: re-run with --with-hook).");
    return;
  }
  if (!fs.existsSync(src)) {
    log(`⚠ hooks/${HOOK_FILE} not found in package — skipping the tool access hook.`);
    return;
  }
  step(5, installed ? "Updating the tool access hook…" : "Installing the tool access hook…");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.mkdirSync(path.join(hermesHome, "logs"), { recursive: true });
  fs.copyFileSync(src, dest);
  if (PLATFORM !== "win32") fs.chmodSync(dest, 0o700);
  log(`✓ Hook copied to ${dest}`);

  const command = PLATFORM === "win32" ? `python "${dest}"` : dest;
  let status;
  try {
    const before = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "";
    const r = addPreToolHook(before, command);
    status = r.status;
    if (status !== "already") fs.writeFileSync(cfgPath, r.text);
    log(status === "already" ? "✓ Hook already registered in config.yaml"
        : status === "updated" ? "✓ Updated the hook command in config.yaml"
        : "✓ Registered the hook under hooks.pre_tool_call in config.yaml");
  } catch (e) {
    log(`⚠ Could not register the hook: ${e.message}`);
    log(`  Add under hooks.pre_tool_call in ${cfgPath}:`);
    log(`    - command: ${JSON.stringify(command)}\n      timeout: 10\n      fail_closed: true`);
  }

  const envPath = path.join(hermesHome, ".env");
  let envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const settings = [
    ["ZALO_HOOK_OWNERS", HOOK_OWNER?.replace(/\s/g, "")],
    ["ZALO_HOOK_OWNER_MODE", HOOK_MODE],
  ];
  let changed = false;
  for (const [key, value] of settings) {
    if (value == null) continue;
    const r = setEnvVar(envText, key, value);
    envText = r.text;
    changed ||= r.changed;
    log(`✓ ${key}=${value} in ${envPath}`);
  }
  if (changed) fs.writeFileSync(envPath, envText, { mode: 0o600 });
  if (!/^\s*ZALO_HOOK_OWNERS=\S/m.test(envText)) {
    log("⚠ No ZALO_HOOK_OWNERS set: every Zalo user is blocked from all tools.");
    log("  Set one with --hook-owner <uid> (ZALO_LOG_IDS=true logs uids).");
  }

  if (status === "added" || status === "updated") {
    log("  Hermes runs a new or changed hook only after you approve it:");
    log(`    hermes ${profile && profile !== "default" ? `-p ${profile} ` : ""}--accept-hooks   (or HERMES_ACCEPT_HOOKS=1)`);
    log("  then restart the gateway.");
  }
}

// Turn on every toolset the plugin provides (plugin.yaml provides_toolsets)
// for the zalo platform. Hermes enables plugin toolsets by default, but once a
// platform has a saved toolset list (`hermes tools`) only the listed ones run.
function enablePluginToolsets(cfgPath, pluginYamlPath) {
  let toolsets = [];
  try {
    toolsets = readProvidedToolsets(fs.readFileSync(pluginYamlPath, "utf-8"));
  } catch {
    return;
  }
  if (!toolsets.length) return;
  try {
    const before = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "";
    const r = enablePlatformToolsets(before, "zalo", toolsets);
    if (r.status === "added") {
      fs.writeFileSync(cfgPath, r.text);
      log(`✓ Enabled toolset(s) for Zalo in config.yaml: ${r.added.join(", ")}`);
    } else if (r.status === "already") {
      log(`✓ Toolset(s) already enabled for Zalo: ${toolsets.join(", ")}`);
    } else {
      log(`✓ Toolset(s) ${toolsets.join(", ")} on by default (no saved Zalo toolset list)`);
    }
  } catch (e) {
    log(`⚠ Could not enable the plugin toolsets: ${e.message}`);
    log(`  Add ${toolsets.join(", ")} under platform_toolsets.zalo in ${cfgPath}`);
  }
}

function nextSteps() {
  const port = process.env.ZALO_PLUGIN_PORT || "8787";
  console.log(`
────────────────────────────────────────────────────────
✓ Zalo plugin is set up.

  Bridge URL:  http://127.0.0.1:${port}
  Health:      curl http://127.0.0.1:${port}/health

Next, register Zalo in Hermes:
  1) hermes gateway setup     → choose "Zalo" (🇻🇳)
  2) hermes gateway           → start relaying

The background service keeps the bridge running and restarts it on crash
or reboot, so you only do the login + setup once.
────────────────────────────────────────────────────────
`);
}

async function main() {
  banner();
  console.log("Hermes Zalo Plugin — installer");
  console.log("(Safe to re-run: deps are upserted, login is skipped if already logged in,");
  console.log(" and the background service is re-registered cleanly.)\n");
  checkPrereqs();

  if (SERVICE_ONLY) {
    installService();
    installHermesPlugins();
    nextSteps();
    return;
  }

  installDeps();
  // --relogin while the service is running: login.mjs refuses (a second Zalo
  // connection would kick the live one), so stop the service first. The
  // service step below starts it again with the new session.
  let stoppedForLogin = false;
  if (RELOGIN && serviceInstalled()) {
    log("\nStopping the running bridge service so the QR login does not collide with it…");
    stoppedForLogin = stopService().ok;
  }
  login({ restartOnFailure: stoppedForLogin });
  if (!NO_SERVICE) installService();
  else if (stoppedForLogin) {
    const r = restartService();
    log(r.ok ? "✓ Bridge service started again with the new session." : `⚠ Could not restart the service: ${r.message}`);
  }
  else log(`\n(Skipping background service — run \`${CLI} start\` to launch the bridge.)`);
  installHermesPlugins();
  nextSteps();
}

main().catch((e) => die(e?.message || String(e)));
